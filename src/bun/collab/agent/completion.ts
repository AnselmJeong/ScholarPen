import type { OllamaMessage } from "../../../shared/rpc-types";

/** Bounds a model call even when a provider fails to honor cancellation. */
export async function completeWithDeadline(
  complete: (messages: OllamaMessage[], signal: AbortSignal) => Promise<string>,
  messages: OllamaMessage[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  signal.throwIfAborted();
  const controller = new AbortController();
  let rejectStop: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (error: Error) => { rejectStop(error); controller.abort(error); };
  const cancel = () => stop(new Error("Cancelled"));
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop(new Error(`The AI did not respond within ${Math.ceil(timeoutMs / 1000)} seconds. Please retry.`)), timeoutMs);
  try {
    return await Promise.race([complete(messages, controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
