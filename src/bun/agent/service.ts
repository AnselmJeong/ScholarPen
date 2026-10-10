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
import { asksForAIScore, detectionInputForRequest, formatAIDetectionReport } from "../../shared/ai-detection";
import { analyzeAIText } from "../ai-detector/service";
import { findCitationEvidence } from "./find-citation";
import { serializeCitationSearchResult } from "../../shared/citation-evidence";

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
    if (params.analysisMode === "find-citation") {
      requestController.signal.throwIfAborted();
      callbacks.onChunk("선택문의 주장을 정리하고 인용 근거를 검색하고 있습니다…\n");
      const heartbeat = setInterval(() => callbacks.onChunk(""), 15_000);
      try {
        const settings = await fileSystem.getSettings();
        const result = await withAgentStreamTimeout(findCitationEvidence({
          ...params,
          provider: params.provider || settings.sidebarAgentProvider,
          model: params.model || settings.sidebarAgentModel,
        }, settings, requestController.signal), "first-response", AGENT_FIRST_RESPONSE_TIMEOUT_MS, () => requestController.abort());
        requestController.signal.throwIfAborted();
        callbacks.onChunk(serializeCitationSearchResult(result));
        callbacks.onDone();
      } finally { clearInterval(heartbeat); }
      return;
    }
    if (!params.analysisMode && asksForAIScore(params.message)) {
      requestController.signal.throwIfAborted();
      const { text, scope } = detectionInputForRequest(params);
      callbacks.onChunk("로컬 모델로 AI 작성 가능성을 계산하고 있습니다…\n\n");
      // Keep the renderer stream alive while local inference is running.
      const heartbeat = setInterval(() => callbacks.onChunk(""), 15_000);
      try {
        const result = await analyzeAIText(text, requestController.signal);
        requestController.signal.throwIfAborted();
        callbacks.onChunk(formatAIDetectionReport(result, scope));
        callbacks.onDone();
      } finally { clearInterval(heartbeat); }
      return;
    }
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
            thinkingLevel: params.thinkingLevel ?? "none",
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
      // Empty chunks carry provider activity while it is thinking.
      callbacks.onChunk(result.value);
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
