// Claude CLI subprocess client
// Finds `claude` binary via Bun.which() or common paths, spawns with
// stream-json output, captures stdout/stderr, tracks session IDs.

import { existsSync } from "fs";

function findClaudeBinary(): string {
  // Try Bun.which first (searches current PATH)
  const found = Bun.which("claude");
  if (found) return found;

  // Fallback: common macOS install locations (for app-launched processes
  // whose PATH may not include ~/.local/bin or npm global bin)
  const home = process.env.HOME ?? "";
  const candidates = [
    `${home}/.local/bin/claude`,
    `${home}/.npm-global/bin/claude`,
    `${home}/.npm/bin/claude`,
    `/usr/local/bin/claude`,
    `/opt/homebrew/bin/claude`,
    `/usr/bin/claude`,
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return "claude"; // last resort — OS will report error if not found
}

const CLAUDE_BIN = findClaudeBinary();
console.log(`[Claude] Binary resolved to: ${CLAUDE_BIN}`);

export interface ClaudeCallbacks {
  onChunk: (text: string) => void;
  onDone: (sessionId: string) => void;
  onInit?: (slashCommands: string[]) => void;
}

export class ClaudeClient {
  /**
   * Streams a claude CLI response.
   * Callers should NOT await this if they need Electrobun messages to flow
   * while the request is pending — use fire-and-forget pattern.
   */
  async streamChat(
    message: string,
    sessionId: string | null,
    projectPath: string | null,
    callbacks: ClaudeCallbacks
  ): Promise<void> {
    const { onChunk, onDone, onInit } = callbacks;

    const args = [
      CLAUDE_BIN,
      "-p", message,
      "--output-format", "stream-json",
      "--permission-mode", "acceptEdits",
    ];
    if (projectPath) args.push("--cwd", projectPath);
    if (sessionId) args.push("--resume", sessionId);

    console.log(`[Claude] Spawning: ${CLAUDE_BIN} -p <msg> --output-format stream-json${projectPath ? ` --cwd ${projectPath}` : ""}${sessionId ? ` --resume ${sessionId}` : ""}`);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: process.env as Record<string, string>,
      });
    } catch (err) {
      onChunk(`❌ claude CLI 실행 실패\n\n\`${CLAUDE_BIN}\`을 찾을 수 없습니다. 설치 여부 확인:\n\`\`\`\nnpm install -g @anthropic-ai/claude-code\n\`\`\``);
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
    let gotAnyOutput = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          gotAnyOutput = true;
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
                } else if (block.type === "tool_use" && typeof block.name === "string") {
                  const input = block.input as Record<string, unknown> | undefined;
                  const detail = input
                    ? Object.entries(input).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(", ")
                    : "";
                  onChunk(`\n\`[🔧 ${block.name}${detail ? `: ${detail}` : ""}]\`\n`);
                }
              }
            }
          }

          if (event.type === "result" && typeof event.session_id === "string") {
            finalSessionId = event.session_id;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Check stderr for auth/error messages
    const stderrText = await stderrTask;
    if (!gotAnyOutput && stderrText) {
      onChunk(`❌ claude CLI 오류:\n\n\`\`\`\n${stderrText}\n\`\`\`\n\n로그인이 필요하면:\n\`claude auth login\``);
    } else if (stderrText) {
      console.warn("[Claude] stderr:", stderrText);
    }

    onDone(finalSessionId);
  }
}

export const claudeClient = new ClaudeClient();
