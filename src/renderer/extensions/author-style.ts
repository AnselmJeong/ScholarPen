import { rpc } from "../rpc";
import { observeAuthorEdits } from "../collab/author-learning";
import type { StyleView } from "../../shared/author-style";
import type { AuthorEdit } from "../../shared/author-learning";

/** Host event bridge: observation is opt-in and stays outside the shared document. */
export function observeAuthorStyle(editor: Parameters<typeof observeAuthorEdits>[0], peer: Parameters<typeof observeAuthorEdits>[1], projectPath: string, filename: string) {
  let active = true, stop: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, AuthorEdit | null>();
  const invoke = (args: unknown) => rpc.extensionsInvoke({ protocolVersion: 1, requestId: crypto.randomUUID(), operation: "scholarpen.author-style.profile", args });
  const flush = () => {
    for (const [blockId, edit] of pending) void invoke({ projectPath, operation: "observe", payload: { filename, blockId,
      ...(edit ? { before: edit.before, after: edit.after } : { remove: true }) } }).catch(() => {});
    pending.clear();
  };
  let revision = 0;
  const refresh = async () => {
    const current = ++revision;
    try {
      const view = await invoke({ projectPath, operation: "view" }) as StyleView;
      if (!active || current !== revision) return;
      stop?.(); stop = undefined; clearTimeout(timer); pending.clear();
      if (view.config.observe && view.activeProfileId) stop = observeAuthorEdits(editor, peer, (blockId, edit) => {
        pending.set(blockId, edit); clearTimeout(timer); timer = setTimeout(flush, 1500);
      });
    } catch { /* Disabled plugins never collect data. */ }
  };
  void refresh(); window.addEventListener("scholarpen:style-changed", refresh);
  return () => { active = false; stop?.(); clearTimeout(timer); pending.clear(); window.removeEventListener("scholarpen:style-changed", refresh); };
}
