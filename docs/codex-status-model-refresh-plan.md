# Codex status and model refresh

Fix the status bar's missing Codex provider branch and use live subscription
login state instead of assuming every non-Ollama provider is connected.

- Poll Codex status only while Codex is selected; ignore late responses after
  provider changes or unmounts.
- Report the actual app-server executable and version from its handshake.
- Make Settings refresh reconnect the app-owned process and reload its catalog,
  so CLI upgrades apply without restarting ScholarPen. Preserve a pending login
  and reject reconnects during generation.
- Recognize the current nested ChatGPT/Codex app CLI layout for Finder launches.
- Preserve the selected model, account-default option, isolated authentication,
  quota checks, and no paid API fallback.

Current diagnosis (2026-10-02): the status label falls through to Ollama for the
Codex provider. The selected external CLI is 0.160.0; the real ScholarPen client
returns gpt-6.1-sol as its default. No CLI upgrade or hardcoded model is needed.

Verify provider/status transitions, fresh catalog after reconnect, protection of
active turns, CLI diagnostics, typecheck, and release build. Then validate the
installed app's status and picker. Preserve all pre-existing worktree edits.

## Verification

- 30 focused tests passed; TypeScript and git diff checks passed.
- Real ScholarPen client, before and after reconnect: connected via CLI 0.160.0;
  gpt-6.1-sol is returned as the account-default model. No inference was needed.
- Production build succeeded and the DMG checksum is valid.
- Replaced /Applications/ScholarPen.app after backing up the previous bundle
  under ScholarPen/app-backups/20261002-062608-codex-refresh.
- Installed app status now reads Codex (ChatGPT) connected; Settings reports
  Codex CLI 0.160.0. The existing gpt-5.6-sol selection is preserved.
- Clicked Settings refresh in the installed app, waited for reconnection, then
  opened its model picker: gpt-6.1-sol is present alongside the previous models.
