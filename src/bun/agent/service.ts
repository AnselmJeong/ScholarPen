import type { AgentStreamParams } from "../../shared/rpc-types";
import {
  AGENT_FIRST_RESPONSE_TIMEOUT_MS,
  AGENT_STREAM_IDLE_TIMEOUT_MS,
  AgentStreamTimeoutError,
  agentStreamTimeoutMessage,
  withAgentStreamTimeout,
} from "../../shared/agent-stream-timeout";
import { fileSystem } from "../fs/manager";
import { buildAgentMessages } from "./context-builder";
import { streamAgentModel } from "./providers";

export async function streamScholarAgent(
  params: AgentStreamParams,
  callbacks: {
    onChunk: (text: string) => void;
    onDone: () => void;
    onError: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(signal?.reason);
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener("abort", abortRequest, { once: true });

  try {
    let references = "";
    const firstResult = await withAgentStreamTimeout(
      (async () => {
        const settings = await fileSystem.getSettings();
        const provider = params.provider || settings.sidebarAgentProvider;
        const model = params.model || settings.sidebarAgentModel;
        const context = await buildAgentMessages(
          { ...params, provider, model },
          settings,
          requestController.signal,
        );
        references = context.references;
        const iterator = streamAgentModel(
          {
            provider,
            model,
            messages: context.messages,
            signal: requestController.signal,
          },
          settings,
        )[Symbol.asyncIterator]();
        return { iterator, result: await iterator.next() };
      })(),
      "first-response",
      AGENT_FIRST_RESPONSE_TIMEOUT_MS,
      () => requestController.abort(),
    );

    let result = firstResult.result;
    while (!result.done) {
      if (result.value) callbacks.onChunk(result.value);
      result = await withAgentStreamTimeout(
        firstResult.iterator.next(),
        "idle",
        AGENT_STREAM_IDLE_TIMEOUT_MS,
        () => requestController.abort(),
      );
    }

    if (references) callbacks.onChunk(references);
    callbacks.onDone();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      callbacks.onDone();
      return;
    }
    callbacks.onError(
      err instanceof AgentStreamTimeoutError
        ? agentStreamTimeoutMessage(params.lang, err.phase)
        : (err as Error).message,
    );
  } finally {
    signal?.removeEventListener("abort", abortRequest);
  }
}
