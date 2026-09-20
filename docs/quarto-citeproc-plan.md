# Quarto book citation processing

- Always write top-level `citeproc: true` when the book dialog creates or saves `exports/_quarto.yml`, including custom Typst formats.
- Preserve unrelated YAML options and comments. Do not change manuscript citations or existing project files outside the dialog save flow.
- Verify new configurations, existing configurations, and custom formats with the existing configuration tests; run TypeScript validation.

## Verification

- All 13 configuration tests passed, including automatic citation processing for new books, custom Typst formats, and existing YAML with `citeproc: false`.
- TypeScript validation and `git diff --check` passed.
- Released locally as 1.2.4: the stable macOS arm64 build and DMG checksum verification passed.
- Replaced `/Applications/ScholarPen.app` after backing up 1.2.3; verified the installed version and launch into the main window. The configuration save behavior is covered by the tests above, not a desktop save test.
- The build used the existing local distribution settings, without Developer ID signing or notarization.
