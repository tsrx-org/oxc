# Native formatter fixtures

`markless-counter.unformatted.tsrx` is a deliberately compact derivative of
`/Users/jacksm5pro/dev/open-source/markless/poc/fixtures/proofs/ios-native-rendering-target/src/App.tsrx`
as read at Markless revision `fdcb833616c609385419c6b810069ac7df6ba4dd`.
The component structure and behavior are unchanged; whitespace and the
provenance comment were added inside this repository. Markless is an external,
strictly read-only acceptance source.

`conditional.unformatted.tsrx` is project-owned coverage for the retained
statement-position `@if/@else` comparison subset and lexical contexts that must
not be mistaken for TSRX structure. Generalized fixtures live in `../control`.

`semi-false.unformatted.tsrx` is project-owned coverage for tsrx-org/oxc#64: the
`;<` guards a `semi: false` house style used to receive in front of every markup
statement, in each control body and after an unterminated sibling, next to the
`;[` and `;(` guards that are real hazards and stay. The authored guards come
from the issue's own fixtures.
