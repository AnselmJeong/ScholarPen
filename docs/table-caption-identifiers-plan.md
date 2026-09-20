# Table caption identifiers

Recognize table captions immediately above or below a table in both QMD import and legacy ScholarPen JSON. Normalize the caption and identifier into table properties before editor loading, project indexing and export. Preserve original documents on read and avoid consuming styled prose, conflicting table metadata or code examples. Keep existing below-table behavior when a caption sits ambiguously between two unlabelled tables.

Verify @ suggestions, saved/reloaded tables, export/reimport, nested tables, conflicting metadata and the actual tbl-m1-dwell manuscript without rewriting it. Build the updated app after tests and TypeScript checks.

## Result

- Both QMD imports and legacy JSON recognize adjacent captions above or below tables. Caption text, widths and table IDs become table properties; the shared project index therefore includes them in @ suggestions without requiring a fresh import.
- Existing table metadata, styled caption paragraphs and code examples remain protected.
- 261 tests passed, one optional manuscript fixture skipped; TypeScript and diff checks passed.
- The current manuscript's tbl-m1-dwell was indexed successfully. Its actual exported QMD rendered to HTML with a Table 1 link targeting the generated tbl-m1-dwell table.
- The stable app was built. Installed-app replacement is separate from this source/build verification.
