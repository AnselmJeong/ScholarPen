# AISidebar Conversion Plan: assistant-ui Multi-Provider Scholar Agent

## Goal

Remove the current Claude Code wrapper path from `AISidebar` and replace it with a first-party ScholarPen chat agent built on [`assistant-ui`](https://github.com/assistant-ui/assistant-ui).

The new sidebar must support:

- provider/model selection across Ollama, Anthropic Claude API, DeepSeek API, and OpenAI API
- `/` skill or command selection
- `@` project file designation
- KB-grounded answers with references
- streaming chat responses
- Korean/English response mode
- stop/abort
- user-visible errors

The important product shift is this:

- Do not run `claude -p`.
- Do not run `ollama launch claude`.
- Do not rely on Claude Code slash-command behavior.
- Treat skills, files, KB, and tools as ScholarPen-owned context and actions.

Claude remains supported as an LLM provider through the Anthropic API, not through the Claude Code CLI wrapper.

## Implementation Status

Started:

- `@assistant-ui/react` is installed and `AISidebar` now renders through assistant-ui runtime, thread, and composer primitives.
- `claudeStream`, `claudeChunk`, and `src/bun/claude/client.ts` have been removed.
- `agentStream` is the sidebar streaming path.
- Settings now expose Ollama, Claude/Anthropic, DeepSeek, and OpenAI provider/model fields.
- `/` skill selection and `@` file designation are passed as structured agent context.

## Current State

Before this conversion, `src/renderer/components/sidebar/AISidebar.tsx` sent chat requests through `rpc.claudeStream(...)`.

The removed `src/bun/index.ts` `claudeStream` path handled requests by:

1. reading app settings,
2. optionally injecting KB context,
3. choosing direct Claude Code or `ollama launch claude`,
4. starting `claudeClient.streamChat(...)`,
5. forwarding streamed chunks back through `claudeChunk`.

`src/bun/claude/client.ts` then spawns a subprocess:

- direct mode: `claude -p <message> ...`
- Ollama wrapper mode: `ollama launch claude --model <model> -- -p <message> ...`

This path should be retired because it adds fragile layers:

- subprocess startup overhead
- nested CLI parsing
- stream-json parsing
- idle timeout handling
- interactive command hangs
- hidden tool execution policy
- Claude Code session dependency
- provider lock-in through a wrapper rather than explicit provider adapters

## Target Architecture

```text
AISidebarAssistant
  -> @assistant-ui/react runtime
    -> ScholarPenChatAdapter
      -> rpc.agentStream(...)
        -> ScholarAgentService
          -> ModelRouter
             -> OllamaProvider
             -> AnthropicProvider
             -> DeepSeekProvider
             -> OpenAIProvider
          -> SkillRegistry
          -> MentionResolver
          -> KB context builder
          -> deterministic read-only tool layer
          -> agentChunk stream
```

Frontend responsibilities:

- render chat with `@assistant-ui/react`
- keep sidebar-specific controls: provider/model selector, KB toggle, language toggle, context chips
- provide `/` and `@` autocomplete UX around assistant-ui composer
- pass resolved user input and UI-selected context to the agent adapter

Bun main-process responsibilities:

- own API keys and provider calls
- stream model output to renderer
- resolve skill and file context
- enforce context budgets
- enforce read-only defaults and future write confirmations

## assistant-ui Integration

Use `@assistant-ui/react` as the sidebar chat UI and runtime layer.

Context7-checked implementation direction:

- install `@assistant-ui/react`
- use `AssistantRuntimeProvider`
- use a local runtime or custom model adapter for in-memory desktop chat state
- implement a ScholarPen adapter whose `run(...)` calls `rpc.agentStream(...)` and yields streaming text chunks into assistant-ui
- customize Thread, Message, and Composer primitives so the sidebar keeps ScholarPen's compact desktop layout

Do not use assistant-ui as a generic iframe or separate web app. It should replace the hand-rolled message list/composer inside `src/renderer/components/sidebar/AISidebar.tsx`.

Suggested frontend files:

- `src/renderer/components/sidebar/AISidebar.tsx`
- `src/renderer/components/sidebar/assistant/ScholarAssistantRuntime.tsx`
- `src/renderer/components/sidebar/assistant/ScholarThread.tsx`
- `src/renderer/components/sidebar/assistant/ScholarComposer.tsx`
- `src/renderer/components/sidebar/assistant/context-autocomplete.ts`
- `src/renderer/ai/scholar-agent-adapter.ts`

Suggested adapter shape:

```ts
import type { ChatModelAdapter } from "@assistant-ui/react";

export function createScholarAgentAdapter(options: ScholarAgentAdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      // Convert assistant-ui messages to ScholarPen AgentMessage[].
      // Start rpc.agentStream(...).
      // Yield accumulated assistant text as chunks arrive.
      // Respect abortSignal by calling rpc.abortAgentStream(...).
    },
  };
}
```

If assistant-ui's exact adapter type changes, follow the current `@assistant-ui/react` API and keep this boundary: assistant-ui manages thread/composer state; ScholarPen owns provider routing and context assembly.

## Model Provider Settings

Update Settings so the sidebar agent is no longer a binary `ollama | claude` backend.

Replace:

```ts
aiBackend: "ollama" | "claude";
claudeModel: string;
```

With a provider-first schema:

```ts
export type LLMProvider = "ollama" | "anthropic" | "deepseek" | "openai";

export interface ModelProviderSettings {
  provider: LLMProvider;
  model: string;
  baseUrl?: string;
  apiKeyRef?: string;
  enabled: boolean;
}

export interface AppSettings {
  projectsRootDir: string;

  sidebarAgentProvider: LLMProvider;
  sidebarAgentModel: string;
  modelProviders: Record<LLMProvider, ModelProviderSettings>;

  ollamaBaseUrl: string;
  ollamaDefaultModel: string;
  ollamaEmbedModel: string;

  anthropicApiKey: string;
  anthropicDefaultModel: string;

  deepseekApiKey: string;
  deepseekBaseUrl: string;
  deepseekDefaultModel: string;

  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiDefaultModel: string;

  kbChunkSize: number;
  kbChunkOverlap: number;
  kbTopK: number;
  openAlexApiKey: string;
  theme: "light" | "dark" | "system";
}
```

Migration rule:

- if old `aiBackend === "ollama"`, set `sidebarAgentProvider = "ollama"` and copy `ollamaDefaultModel`
- if old `aiBackend === "claude"`, set `sidebarAgentProvider = "anthropic"` and map `claudeModel` to the closest Anthropic model ID
- keep old fields temporarily optional during migration reads, but stop writing them after the new Settings UI ships

Settings UI changes:

- replace the two-button Backend toggle with a provider segmented control: Ollama, Claude, DeepSeek, OpenAI
- show provider-specific fields below the selector
- Ollama: base URL, installed model dropdown, manual model input fallback
- Claude: API key, model select/manual model
- DeepSeek: API key, base URL, model select/manual model
- OpenAI: API key, base URL, model select/manual model
- add a "Test connection" button per provider
- show the active sidebar provider/model in `StatusBar`
- update warning copy so it says the agent is read-only by default and no Claude wrapper is used

Recommended default models:

- Ollama: current `ollamaDefaultModel`, preferring available `qwen` models if no saved model exists
- Claude: `claude-sonnet-4-5` or the latest configured Sonnet-family model available in Settings
- DeepSeek: `deepseek-chat`
- OpenAI: `gpt-5.2` or the user's configured current default

Avoid hard-coding unstable cloud model lists in business logic. Put curated defaults in Settings UI constants and allow custom model IDs.

## Provider Adapter Layer

Add a provider-neutral model router in Bun.

Suggested files:

- `src/bun/agent/model-router.ts`
- `src/bun/agent/providers/types.ts`
- `src/bun/agent/providers/ollama-provider.ts`
- `src/bun/agent/providers/anthropic-provider.ts`
- `src/bun/agent/providers/deepseek-provider.ts`
- `src/bun/agent/providers/openai-provider.ts`

Provider interface:

```ts
export interface AgentModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgentStreamRequest {
  provider: LLMProvider;
  model: string;
  messages: AgentModelMessage[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface AgentProvider {
  stream(request: AgentStreamRequest): AsyncGenerator<string>;
  listModels?(): Promise<string[]>;
  testConnection?(): Promise<void>;
}
```

Provider notes:

- Ollama uses local `ollamaBaseUrl` and `/api/chat` or OpenAI-compatible `/v1/chat/completions`
- Anthropic uses an API key from settings and native streaming
- DeepSeek can use OpenAI-compatible chat completions with `deepseekBaseUrl`
- OpenAI uses OpenAI chat/responses-compatible streaming, selected by the current SDK/API choice used in the repo
- API keys should stay in the Bun process and should not be exposed to the renderer except as masked presence indicators

## `/` Skill And Command System

`/` in the sidebar composer means "load a ScholarPen skill/command as instruction context."

It must not depend on Claude Code.

Search locations:

- `~/.codex/skills/**/SKILL.md`
- `~/.agents/skills/**/SKILL.md`
- `<projectPath>/.scholarpen/skills/**/SKILL.md`
- `<projectPath>/.scholarpen/commands/*.md`
- legacy read-only import: `~/.claude/skills/<name>/SKILL.md`
- legacy read-only import: `~/.claude/commands/<name>.md`
- legacy read-only import: `<projectPath>/.claude/commands/<name>.md`

Suggested file:

- `src/bun/agent/skill-registry.ts`

Suggested API:

```ts
export interface AgentSkill {
  id: string;
  name: string;
  kind: "skill" | "command";
  source: "codex" | "agents" | "project" | "claude-legacy";
  sourcePath: string;
  description?: string;
}

export async function listAgentSkills(projectPath?: string): Promise<AgentSkill[]>;
export async function loadAgentSkill(id: string, projectPath?: string): Promise<AgentSkill & { content: string }>;
```

Behavior:

- sidebar loads skill metadata on project change
- typing `/` opens an assistant-ui-compatible autocomplete surface
- selecting a skill inserts a visible chip and a stable hidden token
- sending a message passes selected skill IDs separately from free text
- if the user manually types `/name`, resolve it before sending
- if duplicate names exist, prefer project skills, then Codex skills, then Agents skills, then Claude legacy imports
- skill markdown is injected as guidance, not executed

## `@` File Designation

`@` in the sidebar composer means "include this project file as explicit model context."

Suggested file:

- `src/bun/agent/mention-resolver.ts`

Supported first:

- `.md`, `.qmd`, `.txt`
- `.bib`
- `.json`
- `.tex`
- `.yaml`, `.yml`
- `.csv`
- current manuscript `.scholarpen.json` converted to readable markdown/text summary

Later:

- PDF text extraction
- DOCX extraction
- image summaries if a vision model is configured

Suggested API:

```ts
export interface MentionedFileContext {
  token: string;
  filePath: string;
  fileName: string;
  displayPath: string;
  content: string;
  truncated: boolean;
}

export async function resolveMentionedFiles(params: {
  message: string;
  explicitFilePaths: string[];
  projectPath: string;
}): Promise<MentionedFileContext[]>;
```

Behavior:

- typing `@` opens project file autocomplete
- file dropdown shows name plus parent folder to disambiguate duplicates
- selected files are stored by absolute path, not just display name
- composer displays a compact chip such as `@methods.qmd`
- hidden send payload includes the exact path
- manually typed `@filename` is resolved if unambiguous
- ambiguous mentions produce a visible clarification error before model call
- unsupported files produce a visible error chip/message

## Context Builder

Suggested file:

- `src/bun/agent/context-builder.ts`

Responsibilities:

- build system prompt
- inject language rule
- inject provider/model capabilities when useful
- inject current project facts
- inject selected skill/command instructions
- inject mentioned file context
- inject KB context when enabled
- keep context within practical bounds

Use explicit tags:

```xml
<scholarpen_system>
...
</scholarpen_system>

<selected_skill id="..." name="..." source="...">
...
</selected_skill>

<mentioned_file path="..." truncated="true|false">
...
</mentioned_file>

<kb_context>
...
</kb_context>
```

Important behavior:

- skill instructions are guidance, not executable code
- mentioned file content should be cited by file name/path
- KB references continue using the existing numbered reference list pattern
- if context was truncated, explicitly tell the model and user-visible response
- never claim access to files or KB snippets that were not injected or read by tools

Base system prompt:

```text
You are ScholarPen's research writing assistant.
Use the provided project files, selected skills, and KB references.
Do not claim to have read files that were not provided.
When a user designates @files, prioritize those files.
When a skill is selected with /skill, follow the skill instructions within ScholarPen's safety limits.
Answer in the requested language.
For academic writing, preserve nuance and cite provided KB references when used.
You are read-only unless the user explicitly accepts a proposed write action.
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

- selected skill content: 12,000 characters each
- all selected skills combined: 30,000 characters
- each mentioned file: 20,000 characters
- all mentioned files combined: 60,000 characters
- KB snippets: existing `kbTopK`, each excerpt max 300 to 700 characters
- chat history: last 8 turns, summarized later if needed

If content exceeds the limit:

- include the beginning and most relevant matched sections
- mark it as truncated
- tell the model that partial content was provided
- show the user which file/skill was truncated

## RPC Changes

Update `src/shared/scholar-rpc.ts`:

- add `listAgentSkills`
- add `listAgentMentionableFiles`
- add `agentStream`
- add `abortAgentStream`
- add `testModelProvider`
- add `listProviderModels`
- add `agentChunk` webview message
- keep `claudeStream` only during migration, then delete it with `src/bun/claude/client.ts`

Suggested request shape:

```ts
export interface AgentStreamParams {
  message: string;
  projectPath: string | null;
  history: AgentMessage[];
  provider: LLMProvider;
  model: string;
  selectedSkillIds: string[];
  selectedFilePaths: string[];
  kbEnabled: boolean;
  lang: "ko" | "en";
}
```

Update `src/renderer/rpc.ts`:

- add `onAgentChunk`
- add `rpc.listAgentSkills(...)`
- add `rpc.listAgentMentionableFiles(...)`
- add `rpc.agentStream(...)`
- add `rpc.abortAgentStream(...)`
- add provider test/list-model calls

Update `src/bun/index.ts`:

- wire new RPC handlers
- keep `activeAgentAbortController`
- forward chunks through `agentChunk`
- keep cloud provider API keys inside Bun process

## AISidebar Changes

Replace the hand-rolled chat body with assistant-ui components in stages.

Stage 1: runtime and stream path

- add assistant-ui dependency
- create `ScholarAgentAdapter`
- wrap the sidebar chat region with `AssistantRuntimeProvider`
- bridge assistant-ui message submission to `rpc.agentStream`
- bridge abort to `rpc.abortAgentStream`
- render streamed chunks as assistant-ui assistant messages
- preserve current KO/EN and KB toggle behavior

Stage 2: provider/model controls

- replace user-facing `Claude` labels with `Scholar Agent`
- add provider/model picker tied to new Settings
- show missing API key or disconnected provider before send
- update `StatusBar` to display active provider/model

Stage 3: `/` and `@`

- build assistant-ui-compatible autocomplete for slash skills and file mentions
- store selected skills/files as structured context, not text-only mentions
- render context chips above the composer
- allow removing chips before send
- surface ambiguity/unsupported-file errors before model call

Stage 4: response actions

- copy
- insert into editor
- replace selection
- open referenced file
- save as note

Do not add write actions until there is a preview/confirmation UI.

## Tool Calling Roadmap

Version 1:

- no model-driven tools
- deterministic preprocessing for `/skill`, `@file`, KB context
- read-only model response

Version 2:

- add validated read-only tools with a max-iteration loop of 3:
  - `read_file`
  - `search_project`
  - `list_project_files`
  - `search_kb`
  - `get_current_document_text`
- tool calls are validated by name and JSON schema
- tool results are injected into the next model call

Version 3:

- add write-capable actions behind explicit confirmation:
  - propose document patch
  - insert text at current cursor
  - replace selected text
  - create note file

Never allow unrestricted shell by default.

## Error Handling

Every failure should produce a useful chat-visible message.

Examples:

- Ollama disconnected
- cloud provider API key missing
- cloud provider authentication failed
- selected model missing
- provider rate limit
- skill file missing
- selected skill cannot be read
- mentioned file ambiguous
- mentioned file unsupported
- context too large and truncated
- stream aborted
- model returned malformed tool call

Do not silently fail or leave the assistant bubble empty.

## Migration Strategy

1. Add settings schema migration for provider-first model settings.
2. Add provider router and provider adapters.
3. Add `agentChunk` stream path while leaving `claudeChunk` untouched.
4. Add `SkillRegistry`, `MentionResolver`, and `ContextBuilder`.
5. Replace `AISidebar` chat UI with assistant-ui runtime/components.
6. Switch send path from `claudeStream` to `agentStream`.
7. Remove `src/bun/claude/client.ts` and Claude wrapper settings after validation.

The wrapper should not remain as a product fallback. If Claude support is needed, it must go through the Anthropic provider adapter.

## Validation Plan

Manual validation:

- open sidebar with no project
- open sidebar with project
- switch providers: Ollama, Claude, DeepSeek, OpenAI
- test missing API key for cloud providers
- test invalid API key for cloud providers
- test missing Ollama server
- test missing model
- `/` dropdown loads skills
- selecting `/skill` creates a context chip
- manually typed `/skill-name` resolves or errors clearly
- `@` dropdown loads project files
- selecting `@file` creates a context chip
- mention duplicate file names and verify disambiguation
- mention a `.bib` file and ask for summary
- mention a `.md` or `.qmd` file and ask for revision advice
- enable KB and verify references appear
- disable KB and verify no KB references are injected
- stop generation mid-stream
- switch KO/EN language
- verify assistant-ui composer focus, send, abort, copy, and message scrolling

Automated checks:

- `bun x tsc --noEmit`
- `bun x vite build`
- unit tests for:
  - settings migration
  - provider routing
  - provider missing-key errors
  - skill discovery
  - command discovery
  - mention parsing
  - file resolution with duplicate names
  - context truncation
  - prompt assembly
  - assistant-ui adapter abort behavior

## Product Decisions

Default behavior:

- sidebar product name: `Scholar Agent`
- default provider: Ollama when connected, otherwise the last configured provider
- Claude support means Anthropic API, not Claude Code CLI
- DeepSeek and OpenAI use explicit API settings
- `/` means "load this skill/command as instruction context"
- `@` means "include this file content as explicit context"
- KB toggle remains separate from `@` mentions

Security posture:

- read-only by default
- API keys stay in Bun process settings
- explicit confirmation for future writes
- no unrestricted Bash
- no hidden file writes from a chat response
- no automatic transmission of project files unless selected by `@`, KB toggle, or an explicit future tool action

## Open Questions

- Should provider API keys remain in `settings.json` for MVP, or move immediately to macOS Keychain?
- Should assistant-ui thread history persist per project, per document, or only in memory for MVP?
- Should app-native skills live under `.scholarpen/skills` only, or also import Codex/Agents skills by default?
- Should `@file` support folder mentions later, with automatic file ranking inside that folder?
- Should long files be chunk-searched before injection instead of truncated head/tail context?
- Should OpenAI use the Responses API from day one, or start with Chat Completions compatibility to keep DeepSeek/OpenAI adapters aligned?

## Recommended First Implementation Slice

Build this first:

1. Settings schema migration and provider selector UI.
2. Provider router with Ollama and one OpenAI-compatible cloud provider path.
3. assistant-ui runtime wrapper and `ScholarAgentAdapter`.
4. `SkillRegistry` discovery and selected skill injection.
5. `MentionResolver` for text-like project files.
6. `ContextBuilder` for skill, file, KB, and language context.
7. `agentStream` RPC and `AISidebar` switch from Claude stream to agent stream.

This slice removes the Claude wrapper, proves the assistant-ui architecture, and delivers the core `/` skill plus `@` file workflow without introducing write-tool risk.
