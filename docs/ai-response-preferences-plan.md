# Persistent AI response preferences

- Search and Thinking are user preferences, independent of chat sessions. Preserve them across sends, New/Reset, history selection, model/project changes, and sidebar close/reopen.
- Own the preferences above the conditionally mounted sidebar and persist them locally across app restarts. Only explicit user control changes update them; old message metadata must not overwrite current preferences.
- Keep initial defaults of Search off and Thinking none. Preserve Validate/Find Citation's request-specific mandatory search without changing the saved Search preference, and keep global search availability/provider capability checks.
- Update composer copy to describe persistent preferences. Verify persistence/remounts and explicit return to defaults, run existing request-option/review tests, TypeScript, and frontend build. Leave unrelated reference-suggestion changes untouched.

## Validation

- 36 tests passed: React preference ownership/persistence and remount behavior, explicit off/none restoration, invalid/unavailable storage, existing search/provider payloads, and protected selection review/application.
- TypeScript, Vite production frontend build, and `git diff --check` passed. Existing Browserslist-age and bundle-size warnings remain.
- Installed desktop app was not replaced or click-tested. Preference tests use a React/happy-dom harness; backend request tests use mocked network responses.
