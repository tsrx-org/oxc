//! The formatter performance harness: it measures this project against the stock Oxfmt lane on
//! the equivalent TSX and fails the run when a declared budget is missed.

// Benchmark math intentionally converts bounded byte/nanosecond counters to floating point for
// readable rates. The harness is release-only and retains every raw latency/RSS sample.
#![expect(
    clippy::cast_precision_loss,
    clippy::similar_names,
    clippy::struct_field_names,
    clippy::too_many_lines,
    reason = "benchmark math converts bounded counters to floating point and the report structs name their units"
)]

mod budgets;
mod fixtures;
mod in_process;
mod process;
mod report;
mod stats;

use std::{
    env, fs,
    hint::black_box,
    path::{Path, PathBuf},
    process::ExitCode,
};

use oxc_adapter::OXC_REVISION;
use tsrx_format::{FormatMode, format_text};
use tsrx_syntax::{project, scan};

use crate::{
    budgets::{Budgets, ensure_binary, parse_args, resolve_incumbent_binary, validate_budgets},
    fixtures::{build_corpus, build_generalized_control_corpus, create_temp_directory, fnv1a64},
    in_process::{measure_config_session, measure_control, measure_product},
    process::{run_memory_child, run_process_measurements},
    report::{
        Corpus, FormatPhaseTimings, GeneralizedControlCorpus, GeneralizedControlSummary, Host,
        P04Summary, P05Summary, P07Summary, RawSamples, Report, command_path_text, command_text,
        now_millis,
    },
    stats::{
        assert_bool, assert_max, assert_min, distribution, median_u64, phase_distribution, ratio,
    },
};

pub(crate) const HISTORICAL_INCUMBENT_MIB_S: f64 = 1.66;

#[expect(
    clippy::print_stderr,
    reason = "the benchmark binary reports failures on stderr and exits non-zero"
)]
fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().is_some_and(|value| value == "--memory-child") {
        let result = run_memory_child(&arguments);
        return match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("oxc-tsrx format memory child: {error}");
                ExitCode::FAILURE
            }
        };
    }
    match run(arguments.into_iter()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("oxc-tsrx format benchmark: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(arguments: impl Iterator<Item = String>) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("performance gates require a release build".to_string());
    }
    let args = parse_args(arguments)?;
    let budget_source = fs::read_to_string(&args.budget_path).map_err(|error| {
        format!("unable to read budgets {}: {error}", args.budget_path.display())
    })?;
    let mut budgets: Budgets = serde_json::from_str(&budget_source)
        .map_err(|error| format!("invalid formatter benchmark budgets: {error}"))?;
    validate_budgets(&budgets)?;
    ensure_binary(&budgets.candidate_binary, "candidate formatter")?;
    // The report must publish the budget file's own declared paths, so the declared copy is taken
    // before the working copy's incumbent path is resolved against the installed layout.
    let declared_budgets = budgets.clone();
    budgets.stock_oxfmt_binary =
        resolve_incumbent_binary(&budgets.stock_oxfmt_binary, "stock Oxfmt")?;

    let tsrx = build_corpus(budgets.corpus_target_bytes);
    let overlay = scan(&tsrx).map_err(|error| error.to_string())?;
    let tsx = project(&tsrx, &overlay).map_err(|error| error.to_string())?;
    let generalized_control =
        build_generalized_control_corpus(budgets.generalized_control_target_bytes);
    let generalized_control_half =
        build_generalized_control_corpus(budgets.generalized_control_target_bytes / 2);
    let generalized_overlay = scan(&generalized_control).map_err(|error| error.to_string())?;
    let generalized_dynamic_tag_count = generalized_overlay.dynamic_tag_count();
    let generalized_style_payload_count = generalized_overlay.style_block_count();
    let tsrx_path = Path::new("benchmark.tsrx");
    let tsx_path = Path::new("benchmark.tsx");

    for _ in 0..budgets.warmups {
        black_box(measure_control(&tsx)?);
        black_box(measure_product(tsx_path, &tsx)?);
        black_box(measure_product(tsrx_path, &tsrx)?);
        black_box(measure_control(&tsx)?);
    }

    let mut control_before = Vec::with_capacity(budgets.samples);
    let mut control_after = Vec::with_capacity(budgets.samples);
    let mut standard = Vec::with_capacity(budgets.samples);
    let mut projected = Vec::with_capacity(budgets.samples);
    for _ in 0..budgets.samples {
        control_before.push(measure_control(&tsx)?);
        standard.push(measure_product(tsx_path, &tsx)?);
        projected.push(measure_product(tsrx_path, &tsrx)?);
        control_after.push(measure_control(&tsx)?);
    }

    for _ in 0..budgets.generalized_control_warmups {
        black_box(measure_product(tsrx_path, &generalized_control_half)?);
        black_box(measure_product(tsrx_path, &generalized_control)?);
    }
    let mut generalized_control_samples = Vec::with_capacity(budgets.generalized_control_samples);
    let mut generalized_control_half_samples =
        Vec::with_capacity(budgets.generalized_control_samples);
    for sample in 0..budgets.generalized_control_samples {
        if sample % 2 == 0 {
            generalized_control_half_samples
                .push(measure_product(tsrx_path, &generalized_control_half)?);
            generalized_control_samples.push(measure_product(tsrx_path, &generalized_control)?);
        } else {
            generalized_control_samples.push(measure_product(tsrx_path, &generalized_control)?);
            generalized_control_half_samples
                .push(measure_product(tsrx_path, &generalized_control_half)?);
        }
    }

    let expected = &control_before[0].1;
    let direct_output_parity =
        control_before.iter().chain(&control_after).all(|sample| sample.1 == *expected)
            && standard.iter().all(|sample| sample.1 == *expected);
    let direct_bypass = standard.iter().all(|sample| {
        let metadata = &sample.2;
        metadata.mode == FormatMode::Direct
            && metadata.timings.scan_ns == 0
            && metadata.timings.projection_ns == 0
            && metadata.timings.lift_ns == 0
            && metadata.projection_bytes == 0
    });
    let parse_count = projected[0].2.parse_count;
    let pass_count = projected[0].2.pass_count;
    let first_code = &projected[0].1;
    let idempotent = format_text(tsrx_path, first_code)
        .is_ok_and(|second| second.code == *first_code && !second.changed);
    let generalized_control_parse_count = generalized_control_samples[0].2.parse_count;
    let generalized_control_pass_count = generalized_control_samples[0].2.pass_count;
    let generalized_control_embedded_parse_count =
        generalized_control_samples[0].2.embedded_parse_count;
    let generalized_control_embedded_format_ns =
        generalized_control_samples[0].2.timings.embedded_format_ns;
    let generalized_control_style_count = generalized_control_samples[0].2.style_count;
    let generalized_control_code = &generalized_control_samples[0].1;
    let generalized_control_idempotent = format_text(tsrx_path, generalized_control_code)
        .is_ok_and(|second| second.code == *generalized_control_code && !second.changed);

    let temporary = create_temp_directory()?;
    let config_session = measure_config_session(&temporary.join("config-session"))?;
    let process_result = run_process_measurements(&temporary, &tsrx, &tsx, &budgets);
    let cleanup_result = fs::remove_dir_all(&temporary)
        .map_err(|error| format!("unable to remove {}: {error}", temporary.display()));
    let processes = process_result?;
    cleanup_result?;

    let control_ns =
        control_before.iter().chain(&control_after).map(|sample| sample.0).collect::<Vec<_>>();
    let standard_ns = standard.iter().map(|sample| sample.0).collect::<Vec<_>>();
    let projected_ns = projected.iter().map(|sample| sample.0).collect::<Vec<_>>();
    let projected_scan_ns =
        projected.iter().map(|sample| sample.2.timings.scan_ns).collect::<Vec<_>>();
    let projected_projection_ns =
        projected.iter().map(|sample| sample.2.timings.projection_ns).collect::<Vec<_>>();
    let projected_parse_ns =
        projected.iter().map(|sample| sample.2.timings.parse_ns).collect::<Vec<_>>();
    let projected_format_ns =
        projected.iter().map(|sample| sample.2.timings.format_ns).collect::<Vec<_>>();
    let projected_lift_ns =
        projected.iter().map(|sample| sample.2.timings.lift_ns).collect::<Vec<_>>();
    let generalized_control_ns =
        generalized_control_samples.iter().map(|sample| sample.0).collect::<Vec<_>>();
    let generalized_control_half_ns =
        generalized_control_half_samples.iter().map(|sample| sample.0).collect::<Vec<_>>();
    let control_distribution = distribution(&control_ns, tsx.len());
    let standard_distribution = distribution(&standard_ns, tsx.len());
    let projected_distribution = distribution(&projected_ns, tsrx.len());
    let projected_phase_timings = FormatPhaseTimings {
        scan: phase_distribution(&projected_scan_ns),
        projection: phase_distribution(&projected_projection_ns),
        parse: phase_distribution(&projected_parse_ns),
        format: phase_distribution(&projected_format_ns),
        lift: phase_distribution(&projected_lift_ns),
    };
    let generalized_control_distribution =
        distribution(&generalized_control_ns, generalized_control.len());
    let generalized_control_half_distribution =
        distribution(&generalized_control_half_ns, generalized_control_half.len());
    let generalized_control_scaling_ratio = ratio(
        generalized_control_distribution.p50_ns,
        generalized_control_half_distribution.p50_ns,
    ) / (generalized_control.len() as f64
        / generalized_control_half.len() as f64);
    let batch_distribution = distribution(&processes.batch_ns, processes.batch_bytes);
    let candidate_stdin_distribution = distribution(&processes.candidate_stdin_ns, tsrx.len());
    let stock_stdin_distribution = distribution(&processes.stock_stdin_ns, tsx.len());
    let direct_median_latency_ratio =
        ratio(standard_distribution.p50_ns, control_distribution.p50_ns);
    let direct_p95_latency_ratio = ratio(standard_distribution.p95_ns, control_distribution.p95_ns);
    let historical_incumbent_derived_floor_mib_per_second = HISTORICAL_INCUMBENT_MIB_S * 10.0;
    let stdin_ratio = ratio(candidate_stdin_distribution.p95_ns, stock_stdin_distribution.p95_ns);
    let tsrx_rss = median_u64(&processes.tsrx_rss_bytes);
    let tsx_rss = median_u64(&processes.tsx_rss_bytes);
    let rss_ratio = ratio(tsrx_rss, tsx_rss);

    let mut assertions = Vec::new();
    assert_max(
        &mut assertions,
        "p04_direct_median_ratio",
        "candidate standard median / canonical formatter median",
        direct_median_latency_ratio,
        budgets.p04.direct_median_latency_ratio_max,
    );
    assert_max(
        &mut assertions,
        "p04_direct_p95_ratio",
        "candidate standard p95 / canonical formatter p95",
        direct_p95_latency_ratio,
        budgets.p04.direct_p95_latency_ratio_max,
    );
    assert_bool(&mut assertions, "p04_direct_output_parity", direct_output_parity);
    assert_bool(&mut assertions, "p04_direct_bypass", direct_bypass);
    assert_min(
        &mut assertions,
        "p04_sequential_median_mib_s",
        "complete TSRX format median throughput",
        projected_distribution.median_mib_per_second,
        budgets.p04.sequential_median_mib_per_second_min,
    );
    assert_min(
        &mut assertions,
        "p04_sequential_p95_mib_s",
        "complete TSRX format throughput at p95 latency",
        projected_distribution.p95_mib_per_second,
        budgets.p04.sequential_p95_mib_per_second_min,
    );
    assert_min(
        &mut assertions,
        "p04_historical_incumbent_derived_floor_mib_s",
        "candidate median throughput / absolute 16.6 MiB/s floor derived from 10 x a non-comparable historical 1.66 MiB/s incumbent result",
        projected_distribution.median_mib_per_second,
        budgets.p04.historical_incumbent_derived_mib_per_second_min,
    );
    assert_min(
        &mut assertions,
        "p04_default_thread_mib_s",
        "complete multi-file --check throughput at p95 latency",
        batch_distribution.p95_mib_per_second,
        budgets.p04.default_thread_mib_per_second_min,
    );
    assert_min(
        &mut assertions,
        "p04_generalized_control_median_mib_s",
        "complete nested/control/dynamic/style format median throughput",
        generalized_control_distribution.median_mib_per_second,
        budgets.p04.generalized_control_median_mib_per_second_min,
    );
    assert_min(
        &mut assertions,
        "p04_generalized_control_p95_mib_s",
        "complete nested/control/dynamic/style format throughput at p95 latency",
        generalized_control_distribution.p95_mib_per_second,
        budgets.p04.generalized_control_p95_mib_per_second_min,
    );
    assert_max(
        &mut assertions,
        "p04_generalized_control_linear_scaling",
        "full/half median latency normalized by corpus byte ratio",
        generalized_control_scaling_ratio,
        budgets.p04.generalized_control_scaling_ratio_max,
    );
    assert_bool(
        &mut assertions,
        "p04_generalized_control_idempotent",
        generalized_control_idempotent,
    );
    assert_bool(
        &mut assertions,
        "p04_generalized_control_one_parse",
        generalized_control_parse_count == generalized_control_pass_count,
    );
    assert_bool(
        &mut assertions,
        "p04_generalized_dynamic_style_coverage",
        generalized_dynamic_tag_count > 0 && generalized_style_payload_count > 0,
    );
    assert_bool(
        &mut assertions,
        "p04_generalized_style_metadata",
        generalized_control_style_count == generalized_style_payload_count,
    );
    assert_bool(
        &mut assertions,
        "p04_generalized_no_hidden_embedded_parse",
        generalized_control_embedded_parse_count == 0
            && generalized_control_embedded_format_ns == 0,
    );
    assert_bool(&mut assertions, "p04_idempotent", idempotent);
    assert_bool(&mut assertions, "p04_one_parse", parse_count == pass_count);
    assert_bool(
        &mut assertions,
        "p04_config_compiled_once",
        config_session.config_loads == 1 && config_session.config_load_ns > 0,
    );
    assert_bool(
        &mut assertions,
        "p04_config_one_parse_per_file",
        config_session.files == 2 && config_session.parse_count == config_session.pass_count,
    );
    assert_bool(&mut assertions, "p04_config_options_applied", config_session.options_applied);
    assert_max(
        &mut assertions,
        "p05_stdin_p95_ms",
        "fresh candidate TSRX stdin p95 milliseconds",
        candidate_stdin_distribution.p95_ms,
        budgets.p05.stdin_p95_ms_max,
    );
    assert_max(
        &mut assertions,
        "p05_upstream_ratio",
        "candidate TSRX stdin p95 / stock Oxfmt TSX stdin p95",
        stdin_ratio,
        budgets.p05.upstream_latency_ratio_max,
    );
    assert_bool(&mut assertions, "p05_complete_output", processes.complete_output);
    assert_max(
        &mut assertions,
        "p07_rss_ratio",
        "candidate TSRX RSS / canonical TSX RSS",
        rss_ratio,
        budgets.p07.upstream_ratio_max,
    );

    let generated_at_unix_ms = now_millis()?;
    let passed = assertions.iter().all(|assertion| assertion.pass);
    let report = Report {
        schema_version: budgets.schema_version,
        generated_at_unix_ms,
        host: Host {
            os: env::consts::OS,
            architecture: env::consts::ARCH,
            rustc: command_text("rustc", &["--version"]),
            system: command_text("uname", &["-a"]),
            build_profile: "release (codegen-units=1, thin LTO, panic=abort, stripped)",
            oxc_revision: OXC_REVISION,
            stock_oxfmt_version: command_path_text(&budgets.stock_oxfmt_binary, &["--version"]),
        },
        budgets: declared_budgets,
        corpus: Corpus {
            bytes: tsrx.len(),
            equivalent_tsx_bytes: tsx.len(),
            fnv1a64: format!("{:016x}", fnv1a64(tsrx.as_bytes())),
            structural_forms: ["@{", "@if", "@else"],
            note: "Retained statement-control corpus for comparison with earlier formatter reports.",
        },
        generalized_control_corpus: GeneralizedControlCorpus {
            bytes: generalized_control.len(),
            half_bytes: generalized_control_half.len(),
            fnv1a64: format!("{:016x}", fnv1a64(generalized_control.as_bytes())),
            structural_forms: [
                "@{",
                "@if",
                "@else",
                "@for",
                "@empty",
                "index/key",
                "@switch/@case/@default",
                "@try/@pending/@catch",
                "<{dynamic}>",
                "<style>",
            ],
            dynamic_tag_count: generalized_dynamic_tag_count,
            style_payload_count: generalized_style_payload_count,
            note: "Repeated direct JSX-child, nested, expression, annotated loop, switch, source-order try, nested dynamic-tag, and raw-style forms.",
        },
        config_session,
        p04: P04Summary {
            canonical_direct_control: control_distribution,
            candidate_standard_direct: standard_distribution,
            direct_median_latency_ratio,
            direct_p95_latency_ratio,
            direct_output_parity,
            direct_bypass,
            candidate_tsrx_sequential: projected_distribution,
            candidate_tsrx_phase_timings: projected_phase_timings,
            historical_incumbent_baseline_mib_per_second: HISTORICAL_INCUMBENT_MIB_S,
            historical_incumbent_derived_floor_mib_per_second,
            candidate_default_thread_batch: batch_distribution,
            generalized_control: GeneralizedControlSummary {
                candidate_generalized_control: generalized_control_distribution,
                candidate_generalized_control_half: generalized_control_half_distribution,
                generalized_control_scaling_ratio,
                generalized_control_idempotent,
                generalized_control_parse_count,
                generalized_control_pass_count,
                generalized_control_embedded_parse_count,
                generalized_control_embedded_format_ns,
                generalized_control_style_count,
            },
            idempotent,
            parse_count,
            pass_count,
        },
        p05: P05Summary {
            candidate_tsrx_stdin: candidate_stdin_distribution,
            stock_oxfmt_tsx_stdin: stock_stdin_distribution,
            p95_latency_ratio: stdin_ratio,
            fresh_processes: true,
            complete_output_produced: processes.complete_output,
        },
        p07: P07Summary {
            candidate_tsrx_rss_bytes: processes.tsrx_rss_bytes,
            canonical_tsx_rss_bytes: processes.tsx_rss_bytes,
            candidate_tsrx_median_rss_bytes: tsrx_rss,
            canonical_tsx_median_rss_bytes: tsx_rss,
            rss_ratio,
            measurement: "fresh benchmark child after complete in-memory formatted output production",
        },
        raw_samples: RawSamples {
            direct_control_before_ns: control_before.iter().map(|sample| sample.0).collect(),
            direct_control_after_ns: control_after.iter().map(|sample| sample.0).collect(),
            candidate_standard_ns: standard_ns,
            candidate_tsrx_sequential_ns: projected_ns,
            candidate_tsrx_scan_ns: projected_scan_ns,
            candidate_tsrx_projection_ns: projected_projection_ns,
            candidate_tsrx_parse_ns: projected_parse_ns,
            candidate_tsrx_format_ns: projected_format_ns,
            candidate_tsrx_lift_ns: projected_lift_ns,
            candidate_generalized_control_ns: generalized_control_ns,
            candidate_generalized_control_half_ns: generalized_control_half_ns,
            candidate_batch_ns: processes.batch_ns,
            candidate_stdin_ns: processes.candidate_stdin_ns,
            stock_stdin_ns: processes.stock_stdin_ns,
        },
        assertions,
        passed,
        limitations: [
            "The generalized corpus covers every supported control family plus repeated nested dynamic tags and byte-preserved raw style; CSS payload formatting and validation are intentionally outside this lane.",
            "Fresh stdin compares project TSRX behavior with stock Oxfmt on equivalent TSX, not stock .tsrx support.",
            "RSS uses same-binary canonical TSX as the engine control so Node launcher memory cannot distort P07.",
        ],
    };

    let output_path = args.output_path.unwrap_or_else(|| {
        PathBuf::from(format!("benchmarks/native-format/results-{generated_at_unix_ms}.json"))
    });
    let json = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("unable to serialize report: {error}"))?;
    fs::write(&output_path, format!("{json}\n"))
        .map_err(|error| format!("unable to write {}: {error}", output_path.display()))?;
    print_summary(&report, &output_path);
    if !report.passed {
        return Err("one or more frozen formatter performance assertions failed".to_string());
    }
    Ok(())
}

#[expect(
    clippy::print_stdout,
    reason = "the benchmark binary's report on stdout is its contract with the docs site"
)]
fn print_summary(report: &Report, path: &Path) {
    println!("formatter benchmark report: {}", path.display());
    for assertion in &report.assertions {
        println!(
            "{} {} observed={:.3} threshold={:.3}",
            if assertion.pass { "PASS" } else { "FAIL" },
            assertion.name,
            assertion.observed,
            assertion.threshold
        );
    }
}
