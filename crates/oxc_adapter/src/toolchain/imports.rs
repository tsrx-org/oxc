//! The module specifiers one source requests, as written, so the type lane can find the `.tsrx`
//! modules a batch imports without linting them.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ExportAllDeclaration, ExportFromDeclaration, Expression, ImportDeclaration, ImportExpression,
    TSExternalModuleReference, TSImportType,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;

use crate::SourceKind;

/// Every string module specifier `source` requests, in source order and possibly repeated.
///
/// That is `import`/`import type`, `export … from`, `import()` with a literal argument,
/// `import("…")` in a type position, and `import x = require("…")`.
///
/// A source the parser cannot recover is answered with no specifiers, so its imports stay as
/// unresolved as they were. The specifiers are not resolved here; that is the caller's policy.
#[must_use]
pub fn module_specifiers(source: &str, kind: SourceKind) -> Vec<String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, kind.source_type()).parse();
    let mut collector = SpecifierCollector::default();
    collector.visit_program(&parsed.program);
    collector.specifiers
}

#[derive(Default)]
struct SpecifierCollector {
    specifiers: Vec<String>,
}

impl<'a> Visit<'a> for SpecifierCollector {
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        self.specifiers.push(it.source.value.to_string());
        walk::walk_import_declaration(self, it);
    }

    fn visit_export_from_declaration(&mut self, it: &ExportFromDeclaration<'a>) {
        self.specifiers.push(it.source.value.to_string());
        walk::walk_export_from_declaration(self, it);
    }

    fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
        self.specifiers.push(it.source.value.to_string());
        walk::walk_export_all_declaration(self, it);
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        match &it.source {
            Expression::StringLiteral(literal) => self.specifiers.push(literal.value.to_string()),
            Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
                if let Some(quasi) = template.quasis.first()
                    && let Some(cooked) = &quasi.value.cooked
                {
                    self.specifiers.push(cooked.to_string());
                }
            }
            _ => {}
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_ts_import_type(&mut self, it: &TSImportType<'a>) {
        self.specifiers.push(it.source.value.to_string());
        walk::walk_ts_import_type(self, it);
    }

    fn visit_ts_external_module_reference(&mut self, it: &TSExternalModuleReference<'a>) {
        self.specifiers.push(it.expression.value.to_string());
        walk::walk_ts_external_module_reference(self, it);
    }
}

#[cfg(test)]
mod tests {
    use super::module_specifiers;
    use crate::SourceKind;

    #[test]
    fn every_static_dynamic_and_type_position_specifier_is_collected() {
        let source = r#"
import { a } from "./a.tsrx";
import type { B } from './b.tsrx';
import "./side-effect.tsrx";
export { c } from "./c.tsrx";
export type { D } from "./d.tsrx";
export * from "./e.tsrx";
export * as f from "./f.tsrx";
import g = require("./g.tsrx");
type H = import("./h.tsrx").H;
const i = await import("./i.tsrx");
const j = await import(`./j.tsrx`);
const k = await import(`./${name}.tsrx`);
const l = await import(name);
"#;
        assert_eq!(
            module_specifiers(source, SourceKind::TypeScript),
            [
                "./a.tsrx",
                "./b.tsrx",
                "./side-effect.tsrx",
                "./c.tsrx",
                "./d.tsrx",
                "./e.tsrx",
                "./f.tsrx",
                "./g.tsrx",
                "./h.tsrx",
                "./i.tsrx",
                "./j.tsrx",
            ]
        );
    }

    #[test]
    fn jsx_sources_answer_and_unparseable_sources_answer_nothing() {
        let tsx = "import { View } from './View.tsrx';\nexport const app = <View />;\n";
        assert_eq!(module_specifiers(tsx, SourceKind::TypeScriptReact), ["./View.tsrx"]);
        let broken = "import { View } from './View.tsrx';\nconst = ;\n";
        assert_eq!(module_specifiers(broken, SourceKind::TypeScript), Vec::<String>::new());
    }
}
