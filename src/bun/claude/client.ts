// Claude CLI subprocess client
// Finds `claude` binary via Bun.which() or common paths, spawns with
// stream-json output, captures stdout/stderr, tracks session IDs.

import { existsSync } from "fs";
import { readdir } from "fs/promises";

function findOllamaBinary(): string {
  // Try Bun.which first (searches current PATH)
  const found = Bun.which("ollama");
  if (found) return found;

  // Fallback: common macOS install locations
  const home = process.env.HOME ?? "";
  const candidates = [
    `/usr/local/bin/ollama`,
    `/opt/homebrew/bin/ollama`,
    `${home}/.local/bin/ollama`,
    `/usr/bin/ollama`,
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return "ollama"; // last resort — OS will report error if not found
}

const OLLAMA_BIN = findOllamaBinary();
console.log(`[Claude] Ollama binary resolved to: ${OLLAMA_BIN}`);

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
  ): Promise<void> {
    const { onChunk, onDone, onInit } = callbacks;

    const args = [
      OLLAMA_BIN,
      "launch", "--model", model, "claude", "--",
      "-p", message,
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--allowed-tools",
      "Bash",
      "Read",
      "Edit",
      "Glob",
      "Grep",
      "Write",
      "WebSearch",
      "WebFetch",
      "AskUserQuestion",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
    ];
    if (sessionId) args.push("--resume", sessionId);

    console.log(`[Claude] Spawning: ${OLLAMA_BIN} launch --model ${model} claude -- -p <msg(${message.length}chars)> --output-format stream-json${projectPath ? ` (cwd: ${projectPath})` : ""}${sessionId ? ` --resume ${sessionId}` : ""}`);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        ...(projectPath ? { cwd: projectPath } : {}),
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      onChunk(`❌ ollama launch 실행 실패\n\n\`${OLLAMA_BIN}\`을 찾을 수 없습니다. 설치 여부 확인:\n\`\`\`\nbrew install ollama\n\`\`\``);
      onDone("");
      return;
    }

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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
                "";
              const displayMsg = errMsg || "알 수 없는 오류로 응답에 실패했습니다.";
              onChunk(`\n\n⚠️ **오류 발생**\n\n${displayMsg}`);
            } else {
              console.log(`[Claude] Result OK — session: ${finalSessionId}`);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Check exit code — CLI may exit non-zero without a result event
    const exitCode = await proc.exited;
    const stderrText = await stderrTask;

    console.log(`[Claude] Process exited — code: ${exitCode}, gotResult: ${gotResult}, gotAssistantContent: ${gotAssistantContent}`);
    if (stderrText) {
      console.error("[Claude] stderr:\n" + stderrText);
    }

    if (!gotResult && exitCode !== 0) {
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
