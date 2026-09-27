# Codex subscription provider

## Scope

Add Codex beside the existing Sidebar providers. Use the official local Codex
App Server over stdio with ChatGPT OAuth, never an OpenAI API key. Preserve the
Sidebar context builder, search, conversation storage, and response application.

## Implementation

- Discover an installed Codex CLI, including GUI-app and common macOS locations.
- Use a private ScholarPen CODEX_HOME and scratch directory. Force ChatGPT login,
  remove inherited API credentials, disable agent tools, and use read-only turns.
- Implement bounded RPC, login/cancel/logout/status, model discovery, streamed
  text and images, cancellation, process recovery and shutdown cleanup.
- Verify ChatGPT authentication and included usage before every generation.
  Exhausted or unavailable allowance stops the request; never switch provider,
  use paid API credentials, purchase credits, or consume a limit reset.
- Expose login state, quota/reset information, and model selection in Settings.
- Migrate old settings without changing their selected provider or model.
- Release smoke testing exposed an existing port-5173 collision: restrict Vite
  probing to the dev channel so the release actually loads ScholarPen's UI.

## Verification and delivery

- Protocol tests: login lifecycle, malformed responses, streaming, cancellation,
  process failure, quota exhaustion, API-key rejection, and no paid API fallback.
- Settings migration and UI tests; typecheck, test suite, production build.
- Smoke-test the installed Codex App Server protocol and authentication state.
- Bump 1.2.5 to 1.3.0; stage only this feature, commit, push, verify remote SHA.
- Keep pre-existing uncommitted editor/file-management changes intact.

Sources: https://learn.chatgpt.com/docs/app-server and
https://learn.chatgpt.com/docs/auth. Protocol fields verified against local
codex-cli 0.154.0 generated TypeScript definitions.

## Validation results

- 27 focused tests passed, including no-API-fallback and exhausted-quota cases.
- TypeScript checks passed for both the working tree and the isolated staged tree.
- Full working-tree suite: 336 passed, 1 skipped, 1 existing failure. Isolated
  staged tree: 320 passed, 1 skipped, the same existing failure. The theme test
  references deleted `IconRail.tsx`; the initial pre-change snapshot also fails.
- Real Codex 0.154.0: ChatGPT OAuth completed, account quota and models loaded,
  and a subscription-only turn returned `ScholarPen subscription connected`.
- Full Sidebar backend (`streamScholarAgent`) supplied a synthetic active
  document and returned its requested text, `구독 연결 검증 완료`, with normal
  completion and no error through the Codex provider.
- Packaged macOS app opened its bundled UI, displayed the connected account,
  model picker, remaining allowance and reset time. DMG checksum verified.
- Production build uses the repository's existing unsigned/non-notarized setup.

## Using the connection

Open Settings → Sidebar Provider → Codex. Install the official Codex CLI if the
installation notice appears. Sign in with ChatGPT, select an available model (or
the account default), and Save Settings. OAuth credentials are stored by Codex
under `~/Library/Application Support/ScholarPen/codex`, separate from other Codex
clients. No key is entered into ScholarPen for this provider. Logging out here
only clears this ScholarPen connection.

Known limitations: this is the Codex model catalog, not every ChatGPT web model.
Codex has no Chat Completions `max_tokens`/temperature equivalents in this
integration; helper completions rely on their existing concise-output prompts.
The CLI is an external prerequisite; it is not bundled or automatically installed.
