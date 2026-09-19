//! Generating the two synthetic corpora: the ordinary one, and the control-heavy one that keeps
//! the generalized control path from being measured only incidentally.

use std::{env, fmt::Write as _, fs, path::PathBuf};

use crate::report::now_millis;

pub(crate) fn build_corpus(target_bytes: usize) -> String {
    let mut source = String::with_capacity(target_bytes + 2048);
    source.push_str("type Props = { ready: boolean; label: string };\n");
    let payload = "x".repeat(896);
    let mut index = 0usize;
    while source.len() < target_bytes {
        write!(
            source,
            "export function View{index}({{ ready, label }}: Props) @{{\n  const payload = \"{payload}\";\n  const pattern = /@if\\s+\\//gu;\n  <p title={{`@else ${{label}}`}}>@if is text {{payload}}</p>;\n  @if (ready) {{\n    <strong>{{label}}</strong>;\n  }} @else {{\n    <span>{{pattern.source}}</span>;\n  }}\n}}\n"
        )
        .expect("writing to a String cannot fail");
        index += 1;
    }
    source
}

pub(crate) fn build_generalized_control_corpus(target_bytes: usize) -> String {
    let mut source = String::with_capacity(target_bytes + 2048);
    source.push_str(
        "type ControlProps = { ready: boolean; label: string };\n\
         type Row = { id: number; active: boolean; label: string };\n",
    );
    let payload = "control".repeat(16);
    let mut index = 0usize;
    while source.len() < target_bytes {
        write!(
            source,
            "export async function Control{index}({{ ready, label }}: ControlProps) @{{\n\
               const rows: Row[] = [{{ id: {index}, active: ready, label }}];\n\
               const Dynamic = ready ? \"article\" : \"aside\";\n\
               const Child = \"span\";\n\
               const rendered = @if (ready) {{ <b>{{label}}</b> }} @else {{ <i>{payload}</i> }};\n\
               const recovered = @try {{ <mark>{{rendered}}</mark> }} @catch (error: Error, reset: () => void) {{ <button onClick={{reset}}>{{String(error)}}</button> }};\n\
               <section data-control={{\"{index}\"}}>\n\
                 @if (ready) {{\n\
                   <div>\n\
                     @for await (const row of rows; index rowIndex; key row.id) {{\n\
                       <article>\n\
                         @if (row.active) {{ <strong>{{rendered}}</strong> }} @else {{ <span>{{rowIndex}}</span> }}\n\
                       </article>\n\
                     }} @empty {{ <p>{{label}}</p> }}\n\
                   </div>\n\
                 }} @else {{ <aside>{{rendered}}</aside> }}\n\
                 @switch (rows[0].id % 3) {{\n\
                   @case 0: {{\n\
                     @try {{\n\
                       @if (ready) {{ <strong>{{recovered}}</strong> }} @else {{ <span>{{label}}</span> }}\n\
                     }} @pending {{ <i>pending</i> }} @catch (error, reset) {{ <button onClick={{reset}}>{{String(error)}}</button> }}\n\
                   }}\n\
                   @case 1: {{ <small>{{rendered}}</small> }}\n\
                   @default: {{ <u>{{label}}</u> }}\n\
                 }}\n\
                 <{{Dynamic}} data-dynamic={{\"{index}\"}}>\n\
                   <{{Child}} data-child={{label}} />\n\
                   <style data-scope={{\"{index}\"}}>/* raw {{label}} */ .control-{index}{{color:red}} @media (min-width:1px){{.control-{index}::before{{content:\"{{label}}\"}}}}</style>\n\
                 </{{Dynamic}}>\n\
               </section>;\n\
             }}\n"
        )
        .expect("writing to a String cannot fail");
        index += 1;
    }
    source
}

pub(crate) fn create_temp_directory() -> Result<PathBuf, String> {
    let path = env::temp_dir().join(format!(
        "oxc-tsrx-format-benchmark-{}-{}",
        std::process::id(),
        now_millis()?
    ));
    fs::create_dir(&path)
        .map_err(|error| format!("unable to create {}: {error}", path.display()))?;
    Ok(path)
}

pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use tsrx_format::format_text;

    use super::build_generalized_control_corpus;

    #[test]
    fn generalized_dynamic_style_corpus_formats_and_converges() {
        let source = build_generalized_control_corpus(4096);
        let first = format_text(Path::new("benchmark.tsrx"), &source)
            .unwrap_or_else(|error| panic!("{error}\n{source}"));
        let second = format_text(Path::new("benchmark.tsrx"), &first.code).unwrap();
        assert_eq!(second.code, first.code);
        assert_eq!(first.metadata.parse_count, first.metadata.pass_count);
        assert!(first.metadata.style_count > 0);
        assert_eq!(first.metadata.embedded_parse_count, 0);
    }
}
