//! tsrx-org/oxc#79: a file canonical OXC cannot parse is one named, positioned error in the
//! batch, not a batch-wide failure with no file name.

use std::{fs, path::PathBuf};

use tsrx_lint::{LintError, LintSession};

fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("tsrx-lint-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

const PROBE: &str = "export function Probe() @{\n\tconst element = document.createElement('div');\n\tdocument./*completion*/;\n\t<div>{element.dataset}</div>\n}\n";
const CLEAN: &str = "export function Clean() @{\n\tvar count = 0;\n\t<p>{count}</p>\n}\n";

#[test]
fn an_unparsable_file_is_a_named_positioned_error_and_the_batch_continues() {
    let directory = scratch("parse-failure");
    fs::write(directory.join(".oxlintrc.json"), r#"{ "rules": { "no-var": "error" } }"#).unwrap();
    let probe = directory.join("probe.tsrx");
    let clean = directory.join("clean.tsrx");
    fs::write(&probe, PROBE).unwrap();
    fs::write(&clean, CLEAN).unwrap();

    let session = LintSession::new(&directory, None, &[], false).unwrap();
    let outputs = session.lint_files(&[probe.clone(), clean]).unwrap();
    assert_eq!(outputs.len(), 2, "both files report");

    let failed = &outputs[0];
    assert_eq!(failed.diagnostics.len(), 1, "{:?}", failed.diagnostics);
    let diagnostic = &failed.diagnostics[0];
    assert!(diagnostic.filename.ends_with("probe.tsrx"), "{}", diagnostic.filename);
    assert_eq!(diagnostic.severity, "error");
    assert!(diagnostic.message.starts_with("OXC parse failed: "), "{}", diagnostic.message);
    // The parser's span, mapped back onto the authored line that holds the incomplete access.
    let line_start = PROBE.find("\tdocument./*").unwrap();
    let line_end = PROBE[line_start..].find('\n').unwrap() + line_start;
    let offset = diagnostic.labels.first().map(|label| label.span.offset as usize);
    assert!(
        offset.is_some_and(|offset| (line_start..=line_end).contains(&offset)),
        "the diagnostic must land on the authored line ({line_start}..{line_end}), got {offset:?}"
    );

    let linted = &outputs[1];
    assert!(
        linted.diagnostics.iter().any(|item| item.code.contains("no-var")),
        "the clean file still linted: {:?}",
        linted.diagnostics
    );

    // The in-memory lane hands the same facts to the editor as an error it can position.
    let error = session.lint_text(&probe, PROBE).unwrap_err();
    match error {
        LintError::Unparsed(unparsed) => {
            assert!(unparsed.path.ends_with("probe.tsrx"));
            assert_eq!(unparsed.headline, "OXC parse failed");
            assert!(!unparsed.diagnostics.is_empty());
        }
        other => panic!("expected Unparsed, got {other:?}"),
    }
    let _ = fs::remove_dir_all(directory);
}
