// Claude CLI subprocess client
// Supports two launch modes:
//   ollama: `ollama launch claude --model <model> -- <flags>`
//   claude: `claude -p <msg> --model <model> --verbose <flags>` (direct, PATH-resolved)

import { existsSync } from "fs";
import { readdir } from "fs/promises";

function findOllamaBinary(): string {
  const found = Bun.which("ollama");
  if (found) return found;
  for (const p of [`/usr/local/bin/ollama`, `/opt/homebrew/bin/ollama`, `/usr/bin/ollama`]) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return "ollama";
}

function findClaudeBinary(): string {
  const found = Bun.which("claude");
  if (found) return found;
  const home = process.env.HOME ?? "";
  for (const p of [
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    `/usr/local/bin/claude`,
    `/opt/homebrew/bin/claude`,
  ]) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return "claude";
}

/**
 * Builds an augmented environment for subprocesses launched from a packaged
 * macOS app. The app bundle starts with a minimal PATH (/usr/bin:/bin:…)
 * which omits ~/.local/bin, /usr/local/bin, Homebrew, etc.  Claude CLI and
 * Ollama live in those directories, so we prepend common locations to PATH
 * before spawning any child process.
 */
export function buildSubprocessEnv(): Record<string, string> {
  const home = process.env.HOME ?? "";
  const extraPaths = [
    `${home}/.local/bin`,
    `${home}/.npm-global/bin`,
    `/usr/local/bin`,
    `/opt/homebrew/bin`,
    `/opt/homebrew/sbin`,
    `/usr/local/sbin`,
  ].filter(Boolean);

  const currentPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const merged = [...new Set([...extraPaths, ...currentPath.split(":")])].join(":");

  return {
    ...(process.env as Record<string, string>),
    PATH: merged,
    // Ensure HOME is always set — some claude config lookups require it.
    ...(home ? { HOME: home } : {}),
  };
}

const OLLAMA_BIN = findOllamaBinary();
const CLAUDE_BIN = findClaudeBinary();
console.log(`[Claude] ollama: ${OLLAMA_BIN}  claude: ${CLAUDE_BIN}`);

export interface ClaudeCallbacks {
  onChunk: (text: string) => void;
  onDone: (sessionId: string) => void;
  onInit?: (slashCommands: string[]) => void;
}

export class ClaudeClient {
  /**
   * Returns all available slash command names by reading the filesystem directly:
   * - ~/.claude/skills/   → directory names (209+ skills)
   * - ~/.claude/commands/ → *.md filenames without extension (user commands)
   * - <projectPath>/.claude/commands/ → project-specific commands (optional)
   */
  async getSlashCommands(projectPath?: string): Promise<string[]> {
    const home = process.env.HOME ?? "";
    const names = new Set<string>();

    const scanDir = async (dir: string, stripMd: boolean) => {
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          names.add(stripMd && entry.endsWith(".md") ? entry.slice(0, -3) : entry);
        }
      } catch {}
    };

    await Promise.all([
      scanDir(`${home}/.claude/skills`, false),
      scanDir(`${home}/.claude/commands`, true),
      ...(projectPath ? [scanDir(`${projectPath}/.claude/commands`, true)] : []),
    ]);

    return [...names].sort();
  }

  /**
   * Streams a claude CLI response.
   * Callers should NOT await this if they need Electrobun messages to flow
   * while the request is pending — use fire-and-forget pattern.
   */
  async streamChat(
    message: string,
    sessionId: string | null,
    projectPath: string | null,
    model: string,
    callbacks: ClaudeCallbacks,
    backend: "ollama" | "claude" = "ollama",
    allowedTools?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { onChunk, onDone, onInit } = callbacks;

    // Full tool set for slash commands / unrestricted mode
    const FULL_TOOLS = "Bash,Read,Edit,Glob,Grep,Write,WebSearch,WebFetch,AskUserQuestion,TaskCreate,TaskUpdate,TaskList,TaskGet";
    // KB-mode: allow file-system tools for document editing, but block external search
    const KB_TOOLS = "Bash,Read,Edit,Glob,Grep,Write,AskUserQuestion,TaskCreate,TaskUpdate,TaskList,TaskGet";

    const tools = allowedTools ?? FULL_TOOLS;

    let args: string[];
    if (backend === "claude") {
      // Direct: claude -p <msg> --model <model> --output-format stream-json --verbose ...
      args = [
        CLAUDE_BIN,
        "-p", message,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--allowed-tools", tools,
      ];
      if (model) args.push("--model", model);
      if (sessionId) args.push("--resume", sessionId);
      console.log(`[Claude] Direct: ${CLAUDE_BIN} -p <msg(${message.length}chars)>${model ? ` --model ${model}` : ""}${sessionId ? ` --resume ${sessionId}` : ""} tools=${tools === FULL_TOOLS ? "full" : "kb-only"}`);
    } else {
      // Ollama: ollama launch claude --model <model> -y -- -p <msg> ...
      const ollamaArgs = [OLLAMA_BIN, "launch", "claude"];
      if (model) ollamaArgs.push("--model", model);
      ollamaArgs.push("-y", "--");
      const claudeArgs = [
        "-p", message,
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--allowed-tools", tools,
      ];
      if (sessionId) claudeArgs.push("--resume", sessionId);
      args = [...ollamaArgs, ...claudeArgs];
      console.log(`[Claude] Ollama: ${OLLAMA_BIN} launch claude${model ? ` --model ${model}` : ""} -- -p <msg(${message.length}chars)>${sessionId ? ` --resume ${sessionId}` : ""} tools=${tools === FULL_TOOLS ? "full" : "kb-only"}`);
    }

    let proc: ReturnType<typeof Bun.spawn>;
    if (signal?.aborted) {
      onDone("");
      return;
    }

    try {
      proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        ...(projectPath ? { cwd: projectPath } : {}),
        env: buildSubprocessEnv(),
      });
    } catch (err) {
      const bin = backend === "claude" ? CLAUDE_BIN : OLLAMA_BIN;
      const hint = backend === "claude"
        ? "npm install -g @anthropic-ai/claude-code"
        : "brew install ollama";
      onChunk(`❌ 실행 실패\n\n\`${bin}\`을 찾을 수 없습니다:\n\`\`\`\n${hint}\n\`\`\``);
      onDone("");
      return;
    }

    const abortHandler = () => {
      try { proc.kill(); } catch {}
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    // Drain stderr concurrently to prevent blocking
    const stderrTask = (async () => {
      const sr = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let stderrText = "";
      try {
        while (true) {
          const { done, value } = await sr.read();
          if (done) break;
          stderrText += dec.decode(value, { stream: true });
        }
      } finally {
        sr.releaseLock();
      }
      return stderrText.trim();
    })();

    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalSessionId = "";
    let gotAssistantContent = false; // true once we see text from an assistant event
    let gotResult = false;

    // Kill the process if it produces no output for IDLE_TIMEOUT_MS.
    // Covers commands like /usage that output a response but then hang
    // without ever closing stdout or exiting.
    const IDLE_TIMEOUT_MS = 15_000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleKilled = false;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleKilled = true;
        try { proc.kill(); } catch {}
      }, IDLE_TIMEOUT_MS);
    };
    resetIdleTimer();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "system") {
            const cmds = (event as any).slash_commands;
            if (Array.isArray(cmds) && onInit) {
              onInit(cmds as string[]);
            }
          }

          if (event.type === "assistant") {
            const content = (event as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string" && block.text) {
                  onChunk(block.text);
                  gotAssistantContent = true;
                } else if (block.type === "tool_use") {
                  // Tool calls are internal — don't surface details to the user.
                  // The loading cursor in the UI already shows that work is in progress.
                }
              }
            }
          }

          if (event.type === "result") {
            gotResult = true;
            if (typeof event.session_id === "string") {
              finalSessionId = event.session_id;
            }
            // Handle error results (usage limit, auth failure, etc.)
            if (event.is_error) {
              console.error("[Claude] is_error result event:", JSON.stringify(event, null, 2));
              const errMsg =
                (typeof event.result === "string" && event.result) ||
                (typeof event.error === "string" && event.error) ||
                (event.result && typeof event.result === "object" ? JSON.stringify(event.result) : "") ||
                "";
              const displayMsg = errMsg
                ? errMsg
                : `알 수 없는 오류 (event dump: \`${JSON.stringify(event).slice(0, 300)}\`)`;
              onChunk(`\n\n⚠️ **오류 발생**\n\n${displayMsg}`);
            } else {
              console.log(`[Claude] Result OK — session: ${finalSessionId}`);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", abortHandler);
    }

    // Check exit code — CLI may exit non-zero without a result event
    const exitCode = await proc.exited;
    const stderrText = await stderrTask;

    console.log(`[Claude] Process exited — code: ${exitCode}, gotResult: ${gotResult}, gotAssistantContent: ${gotAssistantContent}`);
    if (stderrText) {
      console.error("[Claude] stderr:\n" + stderrText);
    }

    if (signal?.aborted) {
      if (!gotAssistantContent) onChunk("중단됨");
    } else if (idleKilled) {
      // Process was killed because it stopped producing output — likely an
      // interactive command (/usage, /cost, etc.) that hangs in -p mode.
      if (!gotAssistantContent) {
        onChunk(`⚠️ 응답이 없어 프로세스를 종료했습니다.\n\n\`/usage\`, \`/cost\` 등 대화형 명령은 지원되지 않습니다.`);
      }
      // If we already showed content, silently close — the response was complete.
    } else if (!gotResult && exitCode !== 0) {
      // No result event + non-zero exit → unexpected failure
      const detail = stderrText ? `\n\n\`\`\`\n${stderrText}\n\`\`\`` : "";
      onChunk(`\n\n⚠️ **claude CLI 오류** (exit ${exitCode})${detail}`);
    } else if (!gotAssistantContent && !gotResult) {
      // No output at all — show stderr or generic message
      if (stderrText) {
        onChunk(`❌ claude CLI 오류:\n\n\`\`\`\n${stderrText}\n\`\`\`\n\n로그인이 필요하면:\n\`claude auth login\``);
      } else {
        onChunk(`❌ claude CLI가 아무 출력도 내보내지 않았습니다 (exit ${exitCode}).`);
      }
    }

    onDone(finalSessionId);
  }
}

export const claudeClient = new ClaudeClient();
