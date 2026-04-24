import type { AgentStreamParams } from "../../shared/rpc-types";
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
  try {
    const settings = await fileSystem.getSettings();
    const provider = params.provider || settings.sidebarAgentProvider;
    const model = params.model || settings.sidebarAgentModel;
    const { messages, references } = await buildAgentMessages({ ...params, provider, model }, settings);

    for await (const chunk of streamAgentModel({ provider, model, messages, signal }, settings)) {
      callbacks.onChunk(chunk);
    }

    if (references) callbacks.onChunk(references);
    callbacks.onDone();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      callbacks.onDone();
      return;
    }
    callbacks.onError((err as Error).message);
  }
}
