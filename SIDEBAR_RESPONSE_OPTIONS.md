# AI Sidebar response options

## Scope
- Add per-question Search off/on and Thinking none/low/medium/high controls.
- Default and reset each new question to Search off and Thinking none; snapshot options before asynchronous work and save them with messages.
- Search off bypasses external search and the search-decision model call. Search on requests the existing scholarly/web retrieval, subject to the global search setting. Explicit Find Citation retains its dedicated retrieval.
- Map thinking to provider-supported request fields and explain model limitations in the composer. Preserve project Sources as a separate control.
- Forward stream activity during reasoning without showing reasoning text, so active thinking does not look like a stalled connection.
- Subscribe message bubbles directly to message state so incoming responses replace the loading indicator immediately.

## Validation
- Regression tests for external-search gating, provider payloads, and reasoning stream activity.
- TypeScript, existing tests, frontend production build, and diff check.
- Browser UI check where available; installed desktop behavior is a separate verification.

## Provider references
- [Ollama OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility): `reasoning_effort` for `/v1/chat/completions`.
- [Ollama thinking](https://docs.ollama.com/capabilities/thinking): model-dependent levels and GPT-OSS minimum.
- [Claude thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking): manual budgets and adaptive effort.
- [DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/): explicit mode and effort.
- [OpenAI GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1): none/low/medium/high.

## Verified
- 177 tests passed, one existing manuscript-fixture test skipped.
- TypeScript and frontend production build passed.
- Live smoke requests to the configured Ollama `deepseek-v4-pro:0813` returned HTTP 200 at all four levels; None returned no reasoning content. These were small correctness probes, not a latency benchmark.
- Isolated browser UI with mocked RPC confirmed Search on / High reaches the request, followed by Search off / None on the next question, and rendered responses update correctly.
- Full browser preview is blocked by the existing Electrobun WebSocket initialization on a non-native page.
- Stable macOS release build passed; installed `/Applications/ScholarPen.app` was backed up and replaced. The installed app launched successfully, displayed Search off / Thinking None, answered a live request, and reset High to None after submission. Version remains 1.1.1; bundle hash `3mi99taixgxhe`. Existing build configuration skips code signing and notarization.
