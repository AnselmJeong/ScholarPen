# Find annotations and reference targets

Scope: extend Cmd-F in the current document and all project documents to find
structured citations, cross-references, and figure/table/heading/equation labels.
Match `@key`, bare keys, and partial keys with the existing literal,
case-insensitive rules. Include legacy numbered figure targets.

- Share the annotation text projection between saved BlockNote documents and
  live ProseMirror documents, preserving identical result order for navigation.
- Highlight reference nodes and target blocks and scroll to their actual bounds.
- Keep ordinary text replacement limited to prose: annotation matches must not
  replace/delete nodes or rename reference identifiers. Explain this in replace UI.
- Continue excluding arbitrary props, image payloads, URLs, and other metadata.
- Verify all reference types, nested/table content, live/saved result parity,
  node positions/decorations, replacement safety, typecheck, and frontend build.
- Preserve existing unrelated work and user documents.

Validation completed:
- Full suite: 280 passed, 1 existing fixture-dependent test skipped.
- Final focused suite: 18 passed, including the additional repeated-key highlight
  regression. Mounted real BlockNote editors verify live/saved result ordering,
  reference/target node decorations, next/previous navigation, project result
  navigation requests, and preservation of reference nodes during replacement.
- TypeScript, production frontend build, and `git diff --check` passed.
- User documents and the installed desktop application were not modified; the
  mounted component checks use a DOM test environment, not the installed app.
