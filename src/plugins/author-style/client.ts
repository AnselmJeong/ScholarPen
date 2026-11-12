import { rpc } from "../../renderer/rpc";
import type { StyleCommand, StyleView } from "../../shared/author-style";
export const STYLE_CHANGED = "scholarpen:style-changed";
export async function styleCommand<T = StyleView>(command: StyleCommand, requestId = crypto.randomUUID()): Promise<T> {
  const result = await rpc.extensionsInvoke({ protocolVersion: 1, requestId, operation: "scholarpen.author-style.profile", args: command });
  if (!result || typeof result !== "object") throw new Error("문체 프로필은 ScholarPen 데스크톱 앱에서 사용할 수 있습니다.");
  if (!["view", "compare", "export", "observe"].includes(command.operation)) window.dispatchEvent(new CustomEvent(STYLE_CHANGED));
  return result as T;
}
