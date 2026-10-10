# Claude subscription connection

Replace only the Claude API provider. Keep the persisted `anthropic` provider ID
so existing conversations, selected models, and project settings keep working.
Other model providers and scholarly-search credentials remain available.

## Connection and billing boundary

- Run the user's installed, unmodified official Claude Code binary. Tested with
  2.1.273 and 2.1.296; 2.1.273 is the current minimum supported version for this integration.
- Official `auth login --claudeai`, `auth status --json`, and `auth logout` own
  authentication. `CLAUDE_CONFIG_DIR` isolates ScholarPen's login from the
  user's ordinary Claude Code configuration. ScholarPen never reads or copies
  OAuth tokens.
- Before each generation, require `loggedIn`, `authMethod: claude.ai`,
  `apiProvider: firstParty`, and a subscription type.
- Use an environment allowlist. Do not pass inherited API credentials, OAuth
  tokens, provider endpoints, or model overrides. Ignore user/project settings;
  enable safe mode and explicitly disable tools, MCP, skills, hooks, Chrome,
  and session persistence. Prompts travel over stdin/private temporary files.
- No Claude HTTP API implementation, key input, Console login, paid-provider
  retry, or fallback model. Settings normalization discards the legacy Claude
  key, including on save. The internal model-setting name remains compatible.
- Abort on rejected rate-limit events, overage events, HTTP 429 retry events,
  or terminal quota errors. A known future reset blocks subsequent turns.
- This guarantees no automatic paid API fallback by ScholarPen. Account-level
  extra usage is separate: the CLI can report overage only after a response.
  This is not an atomic server-side zero-spend cap. The UI explains that
  distinction and links to the account's usage controls.
- Model choices are official CLI aliases, not an account model catalog.
  Model access is enforced by Claude Code; a failure never switches models.

## Application coverage

Both `completeAgentModel` and `streamAgentModel` route the `anthropic` provider
to this client, covering sidebar conversations, research-query helpers,
bibliography repair, citation claims, and the collaborative editing/review
completion path. Existing Ollama-only BlockNote transport stays separate,
as it does for Codex. Provider selection never falls through to that transport
on a Claude failure.

Settings expose sign-in/cancel/logout, CLI refresh, account and model selection.
The status bar polls actual Claude connection state. Quota display explicitly
labels its data as the last observed response, not a live remaining balance.

## Verification

- Fake CLI exercises streaming/UTF-8, history/images, authentication rejection,
  quota and overage failures, no HTTP fallback, malformed/truncated output,
  cancellation, timeouts, login/logout, and temporary-file cleanup.
- Component tests cover authentication controls, model selection, errors,
  observed quota, and stale responses after switching providers.
- Live official browser login succeeded with a Pro account. The actual
  `completeAgentModel` provider returned `ScholarPen Claude subscription OK`.
- TypeScript and release build passed. Full backend/shared suite: 371 pass,
  one failure in the existing reviewer-prompt wording expectation (`skeptical
  journal referee` in `scholarpen-ai.test.ts`); those files were already modified
  before this task and were left untouched. All 14 subscription UI tests passed.
- Packaged GUI verified with `PATH=/usr/bin:/bin` and a scratch settings root:
  Claude Pro connected, settings saved without the old Claude key, and the
  sidebar returned `CLAUDE_SUBSCRIPTION_UI_OK`. The CLI reported 2.1.296 in
  the packaged GUI run.
- The generated self-extracting launcher failed with `UnexpectedEndOfStream`.
  System tar successfully unpacked the exact build payload. The verified flat
  app is at `build/claude-subscription/ScholarPen.app`; its runtime/resources
  match the GUI-tested payload. The existing installed app was not replaced.

Official references checked October 10, 2026:

- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/legal-and-compliance
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
