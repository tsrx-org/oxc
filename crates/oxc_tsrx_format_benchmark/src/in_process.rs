//! The in-process measurements, which is where the per-phase timings and the config-reuse counts
//! come from: a subprocess can only ever report a total.

use std::{fs, path::Path, time::Instant};

use oxc_adapter::{FormatRequest, SourceKind};
use tsrx_format::{FormatSession, format_text};

use crate::{report::ConfigSessionSummary, stats::elapsed_ns};

pub(crate) type ProductSample = (u64, String, tsrx_format::FormatMetadata);

pub(crate) fn measure_control(source: &str) -> Result<(u64, String), String> {
    let started = Instant::now();
    let output = oxc_adapter::format(&FormatRequest {
        parse_source: source,
        source_kind: SourceKind::TypeScriptReact,
        dynamic_tags: None,
        options: None,
    })?;
    Ok((elapsed_ns(started), output.code))
}

pub(crate) fn measure_product(path: &Path, source: &str) -> Result<ProductSample, String> {
    let started = Instant::now();
    let output = format_text(path, source)?;
    Ok((elapsed_ns(started), output.code, output.metadata))
}

pub(crate) fn measure_config_session(root: &Path) -> Result<ConfigSessionSummary, String> {
    fs::create_dir(root)
        .map_err(|error| format!("unable to create {}: {error}", root.display()))?;
    let config_path = root.join(".oxfmtrc.json");
    fs::write(&config_path, r#"{"singleQuote":true,"semi":false}"#)
        .map_err(|error| format!("unable to write {}: {error}", config_path.display()))?;
    let session = FormatSession::new(root, None)?;
    let tsrx = session.format_text(
        &root.join("configured.tsrx"),
        "export function Configured() @{ const message = \"hello\"; }\n",
    )?;
    let tsx = session.format_text(
        &root.join("configured.tsx"),
        "export const Configured = () => <div title=\"hello\">hello</div>;\n",
    )?;
    let options_applied = tsrx.code.contains("'hello'")
        && !tsrx.code.contains("'hello';")
        && tsx.code.contains("title=\"hello\"")
        && !tsx.code.trim_end().ends_with(';');
    Ok(ConfigSessionSummary {
        config_loads: session.config_loads(),
        config_load_ns: session.config_load_ns(),
        files: 2,
        parse_count: tsrx.metadata.parse_count.saturating_add(tsx.metadata.parse_count),
        pass_count: tsrx.metadata.pass_count.saturating_add(tsx.metadata.pass_count),
        options_applied,
    })
}
