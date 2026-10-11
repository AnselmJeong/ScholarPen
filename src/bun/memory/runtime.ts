import { AuthorLearning } from "./learning";
import { projectMemory } from "./hindsight";
import { ProjectMemorySync } from "./sync";

export const authorLearning = new AuthorLearning(async (messages, signal) => {
  const [{ fileSystem }, { completeAgentModel }] = await Promise.all([import("../fs/manager"), import("../agent/providers")]);
  const settings = await fileSystem.getSettings();
  return completeAgentModel({ provider: settings.sidebarAgentProvider, model: settings.sidebarAgentModel,
    messages, maxTokens: 3000, temperature: 0, signal }, settings);
});
export const projectMemorySync = new ProjectMemorySync(projectMemory, authorLearning);
