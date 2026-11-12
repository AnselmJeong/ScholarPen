import type { BundledPlugin } from "../../shared/extensions/contracts";
import { cleanUnicode } from "./main/watermark/unicode";
export function createPlugin(_services?: unknown): BundledPlugin {
  return { activate(context) { context.register("scholarpen.text-cleanup.inspect", args => cleanUnicode((args as { text: string }).text)); } };
}
