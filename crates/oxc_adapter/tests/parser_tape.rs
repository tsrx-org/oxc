use oxc_adapter::{
    DynamicTagContract,
    parser::{
        OrdinaryParseRequest, ProjectedParseRecovery, ProjectedParseRequest, RejectionMetadata,
        parse_ordinary, parse_to_projected_tape,
    },
};
use tsrx_tape_schema::{FlatTape, ValueKind, ValueRef};

fn write_value(tape: &FlatTape, value: ValueRef, output: &mut String) {
    match value.kind() {
        ValueKind::Missing => panic!("missing value in complete tape"),
        ValueKind::Scalar => {
            if let Some(value) = value.as_inline_u32() {
                write!(output, "{value}").expect("write inline u32");
            } else {
                output.push_str(tape.scalar(value).expect("scalar range"));
            }
        }
        ValueKind::Object => {
            output.push('{');
            for (index, field) in tape.fields(value.as_object().expect("object index")).enumerate()
            {
                if index != 0 {
                    output.push(',');
                }
                output.push('"');
                output.push_str(tape.key(field));
                output.push_str("\":");
                write_value(tape, field.value, output);
            }
            output.push('}');
        }
        ValueKind::List => {
            output.push('[');
            for (index, item) in tape.values(value.as_list().expect("list index")).enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_value(tape, item, output);
            }
            output.push(']');
        }
    }
}

#[test]
fn projected_dynamic_scaffold_is_validated_and_serialized_in_one_parse() {
    let source = "const value=<_t0_D0 _t0_A0_={tag} _t0_Z0_={null}/>;";
    let offsets = [14];
    let projected = parse_to_projected_tape(ProjectedParseRequest {
        filename: "dynamic.tsrx",
        source,
        source_type: None,
        include_ts_fields: false,
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
        recovery: ProjectedParseRecovery::None,
        rejection_metadata: RejectionMetadata::None,
        dynamic_tags: Some(DynamicTagContract {
            prefix: "_t0_",
            count: 1,
            original_offsets: &offsets,
        }),
        synthetic_callee_spans: &[],
    })
    .expect("flat dynamic scaffold serialization");
    assert!(!projected.panicked);
    assert!(projected.errors.is_empty());
    let tape = projected.program.expect("complete dynamic scaffold tape");
    let mut flat_json = String::new();
    write_value(&tape, tape.root(), &mut flat_json);
    assert!(flat_json.contains(r#""name":"_t0_D0""#));
    assert!(flat_json.contains(r#""name":"_t0_A0_""#));
    assert!(flat_json.contains(r#""name":"_t0_Z0_""#));
}

#[test]
fn flat_serializer_matches_public_oxc_estree_serialization() {
    let source = "function View(): JSX.Element { const x = 1; return <main>{x}</main>; }";
    let ordinary = parse_ordinary(OrdinaryParseRequest {
        filename: "plain.tsx",
        source,
        lang: None,
        source_type: None,
        ast_type: Some("js"),
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
    });
    assert!(ordinary.errors.is_empty());

    let projected = parse_to_projected_tape(ProjectedParseRequest {
        filename: "plain.tsrx",
        source,
        source_type: None,
        include_ts_fields: false,
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
        recovery: ProjectedParseRecovery::None,
        rejection_metadata: RejectionMetadata::None,
        dynamic_tags: None,
        synthetic_callee_spans: &[],
    })
    .expect("flat serialization");
    assert!(!projected.panicked);
    assert!(projected.errors.is_empty());
    assert!(projected.comments.is_empty());

    let tape = projected.program.expect("complete Program tape");
    let mut flat_json = String::new();
    write_value(&tape, tape.root(), &mut flat_json);
    assert_eq!(ordinary.program_and_fixes, format!("{{\"node\":\n{flat_json}\n,\"fixes\":[]}}"));
}

#[test]
fn ordinary_tsx_uses_the_direct_public_oxc_result_shape() {
    let result = parse_ordinary(OrdinaryParseRequest {
        filename: "plain.tsx",
        source: "const view = <main />;",
        lang: None,
        source_type: None,
        ast_type: Some("js"),
        ranges: false,
        preserve_parens: None,
        show_semantic_errors: false,
    });
    assert!(result.errors.is_empty());
    assert!(result.program_and_fixes.starts_with("{\"node\":\n{\"type\":\"Program\""));
    assert!(result.program_and_fixes.ends_with(r#","fixes":[]}"#));
}
use std::fmt::Write as _;
