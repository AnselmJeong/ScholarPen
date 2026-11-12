import { renderQuartoBookProject } from "./main/render";
import { discoverQuartoExtensionFormats } from "./main/extensions";
import type { ExtensionServices } from "../../bun/extensions/services";
import type { CommandHandlers } from "../../shared/extensions/commands";
import { registerCommands } from "../../shared/extensions/commands";
import type { BundledPlugin } from "../../shared/extensions/contracts";
import manifest from "./scholarpen.plugin.json";
/** Bundled entry point with module-specific host services. */
export function createPlugin(services: ExtensionServices["scholarpen.quarto"]): BundledPlugin {
    const { fileSystem, sendProjectUpdated, buildSubprocessEnv } = services;
    const handlers: Pick<CommandHandlers, "discoverQuartoExtensions" | "renderQuartoBook"> = {
        discoverQuartoExtensions: async ({ projectPath }) => discoverQuartoExtensionFormats(await fileSystem.getQuartoProjectDirectory(projectPath)),
        renderQuartoBook: async ({ projectPath, format }) => {
            const result = await renderQuartoBookProject({
                projectDirectory: await fileSystem.getQuartoProjectDirectory(projectPath),
                format,
                environment: buildSubprocessEnv(),
            });
            if (result.status === "success")
                sendProjectUpdated?.({ projectPath });
            return result;
        }
    };
    return { activate(context) {
            registerCommands(context, manifest.id, handlers);
        } };
}
