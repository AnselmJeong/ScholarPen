import { detectorInstaller } from "./main/installer";
import type { ExtensionServices } from "../../bun/extensions/services";
import type { CommandHandlers } from "../../shared/extensions/commands";
import { registerCommands } from "../../shared/extensions/commands";
import type { BundledPlugin } from "../../shared/extensions/contracts";
import manifest from "./scholarpen.plugin.json";
/** Bundled entry point with module-specific host services. */
export function createPlugin(services: ExtensionServices["scholarpen.ai-writing-score"]): BundledPlugin {
    const handlers: Pick<CommandHandlers, "getAIDetectorStatus" | "installAIDetector" | "cancelAIDetectorInstall"> = {
        getAIDetectorStatus: () => detectorInstaller.getStatus(),
        installAIDetector: () => detectorInstaller.start(),
        cancelAIDetectorInstall: () => detectorInstaller.cancel()
    };
    return { activate(context) {
            registerCommands(context, manifest.id, handlers);
            context.onDispose(() => { detectorInstaller.cancel(); });
        } };
}
