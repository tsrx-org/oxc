//! The budget file's schema, and the argument parsing that locates it. Every threshold this
//! harness asserts is declared there rather than in code.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub(crate) struct Args {
    pub(crate) budget_path: PathBuf,
    pub(crate) output_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Budgets {
    pub(crate) schema_version: u32,
    pub(crate) warmups: usize,
    pub(crate) samples: usize,
    pub(crate) generalized_control_warmups: usize,
    pub(crate) generalized_control_samples: usize,
    pub(crate) batch_warmups: usize,
    pub(crate) batch_samples: usize,
    pub(crate) cold_process_samples: usize,
    pub(crate) rss_process_samples: usize,
    pub(crate) corpus_target_bytes: usize,
    pub(crate) generalized_control_target_bytes: usize,
    pub(crate) batch_corpus_target_bytes: usize,
    pub(crate) memory_corpus_target_bytes: usize,
    pub(crate) candidate_binary: PathBuf,
    pub(crate) stock_oxfmt_binary: PathBuf,
    pub(crate) p04: P04Budget,
    pub(crate) p05: P05Budget,
    pub(crate) p07: P07Budget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct P04Budget {
    pub(crate) direct_median_latency_ratio_max: f64,
    pub(crate) direct_p95_latency_ratio_max: f64,
    pub(crate) sequential_median_mib_per_second_min: f64,
    pub(crate) sequential_p95_mib_per_second_min: f64,
    pub(crate) historical_incumbent_derived_mib_per_second_min: f64,
    pub(crate) default_thread_mib_per_second_min: f64,
    pub(crate) generalized_control_median_mib_per_second_min: f64,
    pub(crate) generalized_control_p95_mib_per_second_min: f64,
    pub(crate) generalized_control_scaling_ratio_max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct P05Budget {
    pub(crate) stdin_p95_ms_max: f64,
    pub(crate) upstream_latency_ratio_max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct P07Budget {
    pub(crate) upstream_ratio_max: f64,
}

pub(crate) fn parse_args(mut arguments: impl Iterator<Item = String>) -> Result<Args, String> {
    if arguments.next().as_deref() != Some("--assert") {
        return Err("expected --assert <budgets.json> [--output <report.json>]".to_string());
    }
    let budget_path = PathBuf::from(arguments.next().ok_or("--assert requires a budget path")?);
    let mut output_path = None;
    while let Some(argument) = arguments.next() {
        if argument != "--output" {
            return Err(format!("unsupported benchmark option: {argument}"));
        }
        if output_path.is_some() {
            return Err("--output may be specified only once".to_string());
        }
        output_path = Some(PathBuf::from(arguments.next().ok_or("--output requires a path")?));
    }
    Ok(Args { budget_path, output_path })
}

pub(crate) fn validate_budgets(budgets: &Budgets) -> Result<(), String> {
    if budgets.schema_version != 2 {
        return Err("unsupported formatter budget schema".to_string());
    }
    if budgets.warmups < 5
        || budgets.samples < 30
        || budgets.generalized_control_warmups < 5
        || budgets.generalized_control_samples < 15
        || budgets.batch_warmups < 5
        || budgets.batch_samples < 15
        || budgets.cold_process_samples < 20
        || budgets.rss_process_samples < 5
        || budgets.generalized_control_target_bytes < 256 * 1024
    {
        return Err("formatter sample counts are below the frozen minima".to_string());
    }
    // Re-baselined with the settling pass (tsrx-org/oxc#93): a file the formatter changes is
    // formatted a second time to confirm or correct the first pass, and every benchmark corpus
    // is unformatted, so the direct-route ratio against the single-pass canonical control moved
    // from 1.05/1.08 to 2.25/2.3 (observed 2.04/1.95) and the generalized-control floors from
    // 15/12 MiB/s to 7/6 MiB/s (observed 8.26-8.93 median, 7.35-8.48 p95). Clean input still costs one pass.
    if budgets.p04.direct_median_latency_ratio_max > 2.25
        || budgets.p04.direct_p95_latency_ratio_max > 2.3
        || budgets.p04.sequential_median_mib_per_second_min < 15.0
        || budgets.p04.historical_incumbent_derived_mib_per_second_min < 16.6
        || budgets.p04.default_thread_mib_per_second_min < 100.0
        || budgets.p04.generalized_control_median_mib_per_second_min < 7.0
        || budgets.p04.generalized_control_p95_mib_per_second_min < 6.0
        || budgets.p04.generalized_control_scaling_ratio_max > 1.35
        || budgets.p05.stdin_p95_ms_max > 110.0
        || budgets.p05.upstream_latency_ratio_max > 1.25
        // Re-baselined from 1.15 with the OXC crates v0.150.0 upgrade: stock Oxfmt 0.68.0's
        // own peak RSS fell from ~182 MiB to ~157 MiB while the candidate's fell from ~208 MiB
        // to ~194 MiB, so the ratio rose although both absolute numbers improved.
        || budgets.p07.upstream_ratio_max > 1.30
    {
        return Err("formatter budgets weaken the frozen performance contract".to_string());
    }
    Ok(())
}

pub(crate) fn ensure_binary(path: &Path, label: &str) -> Result<(), String> {
    path.is_file()
        .then_some(())
        .ok_or_else(|| format!("{label} binary is missing: {}", path.display()))
}

/// Locate an incumbent binary declared in the budget file.
///
/// The declared path is relative to the repository root, which is where the harness runs, and it
/// is honoured first so any layout that really does install into a repository-root `node_modules`
/// keeps measuring exactly what the budget names. pnpm instead installs each workspace package's
/// dependencies under the package that declares them, so the fallback looks for the same package
/// name under `packages/toolchain/node_modules`. That mirrors the JavaScript lanes, which resolve
/// `oxlint-current` and `oxfmt-current` through `createRequire` from `packages/toolchain`
/// (`benchmarks/vite/run.mjs`, `benchmarks/comparative/run.mjs`).
///
/// The returned path is for measurement only. The budget struct that reaches the report keeps the
/// declared value, so the report's `budgets` block stays byte-faithful to `budgets.json`.
pub(crate) fn resolve_incumbent_binary(declared: &Path, label: &str) -> Result<PathBuf, String> {
    if declared.is_file() {
        return Ok(declared.to_path_buf());
    }
    let fallback = toolchain_package_path(declared);
    if let Some(path) = fallback.as_ref().filter(|path| path.is_file()) {
        return Ok(path.clone());
    }
    Err(match fallback {
        Some(path) => {
            format!("{label} binary is missing at {} and {}", declared.display(), path.display())
        }
        None => format!("{label} binary is missing: {}", declared.display()),
    })
}

/// Rewrite `node_modules/<package>/<rest>` to `packages/toolchain/node_modules/<package>/<rest>`,
/// keeping the declared package name. Paths with no `node_modules` component have no fallback.
fn toolchain_package_path(declared: &Path) -> Option<PathBuf> {
    let mut components = declared.components();
    components.find(|component| component.as_os_str() == "node_modules")?;
    let remainder = components.as_path();
    if remainder.as_os_str().is_empty() {
        return None;
    }
    Some(Path::new("packages/toolchain/node_modules").join(remainder))
}
