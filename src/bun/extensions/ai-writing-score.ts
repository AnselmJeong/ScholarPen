import { runExtensionTask } from "./runtime";
import type { AIDetectionReport } from "../../shared/ai-detection";
/** Legacy callers activate the engine lazily; manifests never import Python assets. */
export function analyzeAIText(text: string, signal?: AbortSignal): Promise<AIDetectionReport> {
  return runExtensionTask("scholarpen.ai-writing-score", async scopedSignal => {
    const engine = await import("../../plugins/ai-writing-score/main/service");
    return engine.analyzeAIText(text, scopedSignal);
  }, signal);
}
