//! The results JSON's schema, and the host facts recorded beside it so an archived run stays
//! comparable to a later one.

use std::{
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{
    budgets::Budgets,
    stats::{Assertion, Distribution, PhaseDistribution},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Host {
    pub(crate) os: &'static str,
    pub(crate) architecture: &'static str,
    pub(crate) rustc: String,
    pub(crate) system: String,
    pub(crate) build_profile: &'static str,
    pub(crate) oxc_revision: &'static str,
    pub(crate) stock_oxfmt_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Corpus {
    pub(crate) bytes: usize,
    pub(crate) equivalent_tsx_bytes: usize,
    pub(crate) fnv1a64: String,
    pub(crate) structural_forms: [&'static str; 3],
    pub(crate) note: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneralizedControlCorpus {
    pub(crate) bytes: usize,
    pub(crate) half_bytes: usize,
    pub(crate) fnv1a64: String,
    pub(crate) structural_forms: [&'static str; 10],
    pub(crate) dynamic_tag_count: usize,
    pub(crate) style_payload_count: usize,
    pub(crate) note: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FormatPhaseTimings {
    pub(crate) scan: PhaseDistribution,
    pub(crate) projection: PhaseDistribution,
    pub(crate) parse: PhaseDistribution,
    pub(crate) format: PhaseDistribution,
    pub(crate) lift: PhaseDistribution,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct P04Summary {
    pub(crate) canonical_direct_control: Distribution,
    pub(crate) candidate_standard_direct: Distribution,
    pub(crate) direct_median_latency_ratio: f64,
    pub(crate) direct_p95_latency_ratio: f64,
    pub(crate) direct_output_parity: bool,
    pub(crate) direct_bypass: bool,
    pub(crate) candidate_tsrx_sequential: Distribution,
    pub(crate) candidate_tsrx_phase_timings: FormatPhaseTimings,
    pub(crate) historical_incumbent_baseline_mib_per_second: f64,
    pub(crate) historical_incumbent_derived_floor_mib_per_second: f64,
    pub(crate) candidate_default_thread_batch: Distribution,
    pub(crate) generalized_control: GeneralizedControlSummary,
    pub(crate) idempotent: bool,
    pub(crate) parse_count: u32,
    pub(crate) pass_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneralizedControlSummary {
    pub(crate) candidate_generalized_control: Distribution,
    pub(crate) candidate_generalized_control_half: Distribution,
    pub(crate) generalized_control_scaling_ratio: f64,
    pub(crate) generalized_control_idempotent: bool,
    pub(crate) generalized_control_parse_count: u32,
    pub(crate) generalized_control_pass_count: u32,
    pub(crate) generalized_control_embedded_parse_count: u32,
    pub(crate) generalized_control_embedded_format_ns: u64,
    pub(crate) generalized_control_style_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct P05Summary {
    pub(crate) candidate_tsrx_stdin: Distribution,
    pub(crate) stock_oxfmt_tsx_stdin: Distribution,
    pub(crate) p95_latency_ratio: f64,
    pub(crate) fresh_processes: bool,
    pub(crate) complete_output_produced: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct P07Summary {
    pub(crate) candidate_tsrx_rss_bytes: Vec<u64>,
    pub(crate) canonical_tsx_rss_bytes: Vec<u64>,
    pub(crate) candidate_tsrx_median_rss_bytes: u64,
    pub(crate) canonical_tsx_median_rss_bytes: u64,
    pub(crate) rss_ratio: f64,
    pub(crate) measurement: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConfigSessionSummary {
    pub(crate) config_loads: u32,
    pub(crate) config_load_ns: u64,
    pub(crate) files: u32,
    pub(crate) parse_count: u32,
    pub(crate) pass_count: u32,
    pub(crate) options_applied: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawSamples {
    pub(crate) direct_control_before_ns: Vec<u64>,
    pub(crate) direct_control_after_ns: Vec<u64>,
    pub(crate) candidate_standard_ns: Vec<u64>,
    pub(crate) candidate_tsrx_sequential_ns: Vec<u64>,
    pub(crate) candidate_tsrx_scan_ns: Vec<u64>,
    pub(crate) candidate_tsrx_projection_ns: Vec<u64>,
    pub(crate) candidate_tsrx_parse_ns: Vec<u64>,
    pub(crate) candidate_tsrx_format_ns: Vec<u64>,
    pub(crate) candidate_tsrx_lift_ns: Vec<u64>,
    pub(crate) candidate_generalized_control_ns: Vec<u64>,
    pub(crate) candidate_generalized_control_half_ns: Vec<u64>,
    pub(crate) candidate_batch_ns: Vec<u64>,
    pub(crate) candidate_stdin_ns: Vec<u64>,
    pub(crate) stock_stdin_ns: Vec<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    pub(crate) schema_version: u32,
    pub(crate) generated_at_unix_ms: u128,
    pub(crate) host: Host,
    pub(crate) budgets: Budgets,
    pub(crate) corpus: Corpus,
    pub(crate) generalized_control_corpus: GeneralizedControlCorpus,
    pub(crate) config_session: ConfigSessionSummary,
    pub(crate) p04: P04Summary,
    pub(crate) p05: P05Summary,
    pub(crate) p07: P07Summary,
    pub(crate) raw_samples: RawSamples,
    pub(crate) assertions: Vec<Assertion>,
    pub(crate) passed: bool,
    pub(crate) limitations: [&'static str; 3],
}

pub(crate) fn now_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|error| error.to_string())
}

pub(crate) fn command_text(program: &str, arguments: &[&str]) -> String {
    Command::new(program)
        .args(arguments)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map_or_else(
            || "unavailable".to_string(),
            |output| String::from_utf8_lossy(&output.stdout).trim().to_string(),
        )
}

pub(crate) fn command_path_text(program: &Path, arguments: &[&str]) -> String {
    Command::new(program)
        .args(arguments)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map_or_else(
            || "unavailable".to_string(),
            |output| String::from_utf8_lossy(&output.stdout).trim().to_string(),
        )
}
