import type { ExtensionServices } from "../../bun/extensions/services";
import { registerCommands } from "../../shared/extensions/commands";
import type { BundledPlugin } from "../../shared/extensions/contracts";
import type { StyleCommand, StyleView } from "../../shared/author-style";
export function createPlugin(services: ExtensionServices["scholarpen.author-style"]): BundledPlugin {
  return { activate(context) {
    const execute = async (command: StyleCommand, signal: AbortSignal) => services.execute(command.scope === "personal" ? "" : await services.resolveProjectPath(command.projectPath), command, signal);
    const legacyView = (view: StyleView) => ({ observations: view.evidence.flatMap(e => e.observation ? [e.observation] : []),
      preferences: view.profiles.flatMap(p => p.rules.filter(r => r.status === "active").map(r => ({ id: r.id, rule: r.instruction, scope: `${p.language}/${p.genre}`, evidenceIds: r.evidenceIds }))), state: "ready" });
    registerCommands(context, "scholarpen.author-style", {
      profile: execute,
      getAuthorLearning: async ({ projectPath }: { projectPath: string }, signal: AbortSignal) => legacyView(await execute({ projectPath, operation: "view" }, signal) as StyleView),
      dismissAuthorPreference: async ({ projectPath, id }: { projectPath: string; id: string }, signal: AbortSignal) => {
        const view = await execute({ projectPath, operation: "view" }, signal) as StyleView;
        const p = view.profiles.find(p => p.rules.some(r => r.id === id));
        if (!p) return legacyView(view);
        return legacyView(await execute({ projectPath, operation: "update", profileId: p.id, expectedRevision: view.revision,
          payload: { name: p.name, rules: p.rules.map(r => r.id === id ? { ...r, status: "dismissed" } : r) } }, signal) as StyleView);
      },
    });
  } };
}
