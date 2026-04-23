# AISidebar Conversion Plan: Ollama-Native Scholar Agent

## Goal

Replace the current Claude Code wrapper path in `AISidebar` with a first-party ScholarPen agent that talks directly to Ollama, while preserving the workflows that matter:

- `/` skill or command selection
- `@` project file mention
- KB-grounded answers with references
- streaming chat responses
- Korean/English response mode
- optional fallback to the existing Claude Code wrapper

The new default should be faster and more predictable than the current `ollama launch claude -- ... claude -p ...` subprocess chain.

## Current State

`src/renderer/components/sidebar/AISidebar.tsx` currently sends chat requests through `rpc.claudeStream(...)`.

`src/bun/index.ts` handles `claudeStream` by:

1. reading app settings,
2. optionally injecting KB context,
3. choosing either direct Claude Code or `ollama launch claude`,
4. starting `claudeClient.streamChat(...)`,
5. forwarding streamed chunks back through `claudeChunk`.

`src/bun/claude/client.ts` then spawns a subprocess:

- direct mode: `claude -p <message> ...`
- Ollama mode: `ollama launch claude --model <model> -- -p <message> ...`

This gives access to Claude Code's slash commands and tools, but it adds several fragile layers:

- subprocess startup overhead
- nested CLI parsing
- stream-json parsing
- idle timeout handling
- interactive command hangs
- stderr/error recovery
- session resume dependency
- tool execution policy hidden inside Claude Code

## Target Architecture

Add a ScholarPen-owned agent backend:

```text
AISidebar
  -> rpc.ollamaAgentStream(...)
    -> ScholarAgentService
      -> SkillRegistry
      -> MentionResolver
      -> KB context builder
      -> Ollama /api/chat stream
      -> optional tool loop
```

Claude Code should remain available as a fallback backend, but the default sidebar path should become Ollama-native.

## Scope For Version 1

Version 1 should be read-oriented and stable.

Include:

- stream chat through Ollama directly
- discover `/` skills and commands without Claude Code
- parse selected `/skill` or `/command`
- read skill/command markdown and inject it into the prompt
- resolve `@file` mentions to project file paths
- read supported text files and inject bounded file context
- keep the current KB toggle and reference list behavior
- keep KO/EN language control
- support stop/abort
- show user-visible errors in the chat bubble

Do not include in Version 1:

- arbitrary shell execution
- direct file writes
- automatic source editing
- web search
- long multi-step task planning with persistent task state
- exact Claude Code session compatibility

These can come later behind explicit tools and UI confirmation.

## Files To Add

### `src/bun/agent/skill-registry.ts`

Responsibilities:

- discover available skill and command names
- load the selected skill or command markdown
- return metadata for sidebar dropdowns

Search locations:

- `~/.claude/skills/<name>/SKILL.md`
- `~/.claude/commands/<name>.md`
- `<projectPath>/.claude/commands/<name>.md`
- optional future location: app-native ScholarPen skills

Suggested API:

```ts
export interface AgentCommand {
  name: string;
  kind: "skill" | "command";
  sourcePath: string;
  description?: string;
}

export async function listAgentCommands(projectPath?: string): Promise<AgentCommand[]>;
export async function loadAgentCommand(name: string, projectPath?: string): Promise<AgentCommand & { content: string }>;
```

### `src/bun/agent/mention-resolver.ts`

Responsibilities:

- parse `@filename` mentions from user input
- resolve mentions against `fileSystem.listProjectFiles(projectPath)`
- read supported file content
- keep context bounded

Supported first:

- `.md`, `.qmd`, `.txt`
- `.bib`
- `.json`
- `.tex`
- `.yaml`, `.yml`
- `.csv`

Later:

- PDF text extraction
- DOCX extraction
- image summaries if vision models are configured

Suggested API:

```ts
export interface MentionedFileContext {
  mention: string;
  filePath: string;
  fileName: string;
  content: string;
  truncated: boolean;
}

export async function resolveMentionedFiles(message: string, projectPath: string): Promise<MentionedFileContext[]>;
```

### `src/bun/agent/context-builder.ts`

Responsibilities:

- build system prompt
- inject language rule
- inject current project facts
- inject skill/command instructions
- inject mentioned file context
- inject KB context when enabled
- keep context within practical bounds

The context should use clear tags:

```xml
<scholarpen_system>
...
</scholarpen_system>

<selected_skill name="...">
...
</selected_skill>

<mentioned_file path="...">
...
</mentioned_file>

<kb_context>
...
</kb_context>
```

Important behavior:

- skill instructions should be treated as task guidance, not as executable code
- mentioned file content should be cited by file name/path
- KB references should continue using the existing numbered reference list pattern
- if context was truncated, explicitly tell the model

### `src/bun/agent/ollama-agent.ts`

Responsibilities:

- run a direct Ollama chat stream
- maintain a simple per-sidebar conversation history
- support abort via `AbortController`
- optionally run a small tool loop later

Version 1 can call Ollama once per user message with assembled context.

Version 2 can add tool calling:

- `read_file`
- `search_project`
- `list_project_files`
- `search_kb`
- `get_current_document_text`

No write tools until there is a diff preview and confirmation UI.

Suggested API:

```ts
export interface AgentStreamParams {
  message: string;
  projectPath: string | null;
  history: AgentMessage[];
  model?: string;
  kbEnabled?: boolean;
  lang?: "ko" | "en";
}

export async function streamOllamaAgent(
  params: AgentStreamParams,
  callbacks: {
    onChunk: (text: string) => void;
    onDone: () => void;
    onError: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<void>;
```

## RPC Changes

Update `src/shared/scholar-rpc.ts`:

- add `getAgentSlashCommands`
- add `ollamaAgentStream`
- add `abortOllamaAgentStream`
- add `agentChunk` message

Keep the existing Claude RPCs during migration.

Update `src/renderer/rpc.ts`:

- add `onAgentChunk`
- add `rpc.getAgentSlashCommands(...)`
- add `rpc.ollamaAgentStream(...)`
- add `rpc.abortOllamaAgentStream()`

Update `src/bun/index.ts`:

- wire new RPC handlers
- keep `activeAgentAbortController`
- forward chunks through `agentChunk`

## AISidebar Changes

Modify `src/renderer/components/sidebar/AISidebar.tsx` in stages.

Stage 1:

- rename user-facing label from `Claude` to `Scholar Agent`
- replace `onClaudeChunk` subscription with `onAgentChunk`
- replace `rpc.getClaudeSlashCommands` with `rpc.getAgentSlashCommands`
- replace `rpc.claudeStream` with `rpc.ollamaAgentStream`
- replace `rpc.abortClaudeStream` with `rpc.abortOllamaAgentStream`
- keep existing dropdown UI for `/` and `@`

Stage 2:

- store selected file path, not only `@file.name`
- disambiguate duplicate file names in dropdown by showing folder path
- render context chips for selected skills/files before sending
- add visible error details for missing files or oversized context

Stage 3:

- support action buttons in assistant responses:
  - insert into editor
  - replace selection
  - copy
  - open referenced file

## Prompt Design

Base system prompt should be strict and app-specific:

```text
You are ScholarPen's local research writing assistant.
Use the provided project files, selected skills, and KB references.
Do not claim to have read files that were not provided.
When a user mentions @file, prioritize that file.
When a skill is selected with /skill, follow the skill instructions within the limits of ScholarPen.
Answer in the requested language.
For academic writing, preserve nuance and cite provided KB references when used.
```

For Korean mode:

```text
답변은 반드시 한국어로 작성한다. 필요한 전문 용어는 영어 병기를 허용한다.
```

For English mode:

```text
Respond in English only.
```

## Context Budget Policy

Initial conservative limits:

- skill/command content: 12,000 characters
- each mentioned file: 20,000 characters
- all mentioned files combined: 60,000 characters
- KB snippets: existing `kbTopK`, each excerpt max 300 to 700 characters
- chat history: last 8 turns, summarized later if needed

If content exceeds the limit:

- include the beginning and most relevant matched sections
- mark it as truncated
- tell the model that only partial content was provided

## Tool Calling Roadmap

Ollama supports chat tools, but not every local model follows tool calling reliably. Treat tools as progressive enhancement, not a hard dependency.

Version 1:

- no model-driven tools
- deterministic preprocessing for `/skill`, `@file`, KB context

Version 2:

- add read-only tools with a max-iteration loop of 3
- tool calls are validated by name and JSON schema
- tool results are injected back into the next Ollama call

Version 3:

- add write-capable tools behind explicit confirmation:
  - propose document patch
  - insert text at current cursor
  - replace selected text
  - create note file

Never allow unrestricted shell by default.

## Error Handling

Every failure should produce a useful chat-visible message.

Examples:

- Ollama disconnected
- selected model missing
- skill file missing
- mentioned file ambiguous
- mentioned file unsupported
- context too large and truncated
- stream aborted
- model returned malformed tool call

Do not silently fail or leave the assistant bubble empty.

## Migration Strategy

1. Add agent backend files and RPC schema.
2. Add `agentChunk` stream path while leaving `claudeChunk` untouched.
3. Switch `AISidebar` to the new agent path behind a feature flag or setting.
4. Make Ollama-native the default after local validation.
5. Keep Claude wrapper as an advanced fallback for full Claude Code behavior.
6. Remove Claude wrapper only after the agent has read/write tools and stable user feedback.

## Validation Plan

Manual validation:

- open sidebar with no project
- open sidebar with project
- `/` dropdown loads skills
- `@` dropdown loads files
- mention a `.bib` file and ask for summary
- mention a `.md` file and ask for revision advice
- enable KB and verify references appear
- disable KB and verify no KB references are injected
- stop generation mid-stream
- switch KO/EN language
- test missing Ollama server
- test missing model

Automated checks:

- `bun x tsc --noEmit`
- `bun x vite build`
- unit tests for:
  - skill discovery
  - command discovery
  - mention parsing
  - file resolution with duplicate names
  - context truncation
  - prompt assembly

## Product Decisions

Default behavior:

- `Scholar Agent` uses Ollama-native backend.
- Claude Code wrapper remains available in Settings as `Claude Code fallback`.
- `/` means “load this skill/command as instruction context.”
- `@` means “include this file content as explicit context.”
- KB toggle remains separate from `@` mentions.

Security posture:

- read-only by default
- explicit confirmation for future writes
- no unrestricted Bash in the first implementation
- no hidden file writes from a chat response

## Open Questions

- Should ScholarPen support app-native skills separate from `~/.claude/skills`?
- Should command names be namespaced when user and project commands collide?
- Should `@file` mentions use exact path tokens internally while showing short names in the UI?
- Which model should be the default for agent mode: current `ollamaDefaultModel`, a code-oriented model, or a writing-oriented model?
- Should long files be chunk-searched before injection instead of truncated head/tail context?

## Recommended First Implementation Slice

Build this first:

1. `SkillRegistry` discovery and load.
2. `MentionResolver` for text-like files.
3. `ContextBuilder` for skill, file, KB, and language context.
4. `ollamaAgentStream` RPC using existing Ollama settings.
5. `AISidebar` switch from Claude stream to agent stream.

This slice gives the core user value without introducing write-tool risk.
