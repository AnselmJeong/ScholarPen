import type { BundledPlugin } from "../../shared/extensions/contracts";
import { countText } from "./count";
export function createPlugin(_services?: unknown): BundledPlugin {
  return { activate(context) { context.register("scholarpen.document-stats.count", args => countText((args as { text: string }).text)); } };
}
