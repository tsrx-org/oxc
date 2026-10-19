use std::path::Path;

use tsrx_lint::LintSession;

#[test]
fn ambient_exports_survive_linting_and_safe_fix_validation() {
    let config = r#"{ "rules": { "no-var": "error" } }"#;
    let lint =
        LintSession::new_with_config_source(Path::new("."), Some(config), &[], false).unwrap();
    let editor =
        LintSession::new_with_config_source(Path::new("."), Some(config), &[], true).unwrap();
    for extension in ["d.ts", "d.mts", "d.cts"] {
        let filename = format!("types/contracts/repro.{extension}");
        let path = Path::new(&filename);
        let source = "export const value: string\nexport var mutable: string\n";
        let output = lint.lint_text(path, source).unwrap();
        assert!(output.diagnostics.iter().any(|diagnostic| diagnostic.code.contains("no-var")));
        let actions = editor.code_actions(path, source).unwrap();
        assert_eq!(actions.len(), 1, "{filename}");
        let action = &actions[0];
        let mut fixed = source.to_string();
        fixed.replace_range(
            action.offset as usize..(action.offset + action.length) as usize,
            &action.replacement,
        );
        assert_eq!(fixed, "export const value: string\nexport let mutable: string\n");
        assert!(editor.code_actions(path, &fixed).unwrap().is_empty());
        assert!(lint.lint_text(path, &fixed).unwrap().diagnostics.is_empty());
    }
}
