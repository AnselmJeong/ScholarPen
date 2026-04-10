// Claude CLI subprocess client
// Spawns `claude -p` with stream-json output, parses chunks, tracks session IDs.

export class ClaudeClient {
  async streamChat(
    message: string,
    sessionId: string | null,
    projectPath: string | null,
    onChunk: (text: string) => void,
    onDone: (newSessionId: string) => void
  ): Promise<void> {
    const args = [
      "claude", "-p", message,
      "--output-format", "stream-json",
    ];
    if (projectPath) args.push("--cwd", projectPath);
    if (sessionId) args.push("--resume", sessionId);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      onChunk(`\`claude\` CLI를 찾을 수 없습니다. 설치 및 PATH 확인 필요.\n\n${err}`);
      onDone("");
      return;
    }

    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalSessionId = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;

            if (event.type === "assistant") {
              const content = (event.message as any)?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && typeof block.text === "string" && block.text) {
                    onChunk(block.text);
                  }
                }
              }
            }

            if (event.type === "result" && typeof event.session_id === "string") {
              finalSessionId = event.session_id;
            }
          } catch {
            // skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    onDone(finalSessionId);
  }
}

export const claudeClient = new ClaudeClient();
