import { createExtension } from "@blocknote/core";
import type { Slice } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { restoreProtectedSelection, type ProtectedSelection } from "./ai-inline-edit-protection";

type Target = { from: number; to: number; slice: Slice; invalid: boolean };
type TargetAction = { id: string; target?: Target };
const targetKey = new PluginKey<Map<string, Target>>("scholarpen-ai-selection-target");

export const AISelectionTargetExtension = createExtension(() => ({
  key: "aiSelectionTarget",
  prosemirrorPlugins: [new Plugin({
    key: targetKey,
    state: {
      init: () => new Map<string, Target>(),
      apply(tr, previous) {
        const action = tr.getMeta(targetKey) as TargetAction | undefined;
        if (!tr.docChanged && !action) return previous;
        const next = new Map(previous);
        if (tr.docChanged) {
          for (const [id, target] of next) {
            if (target.invalid) continue;
            const from = tr.mapping.map(target.from, 1);
            const to = tr.mapping.map(target.to, -1);
            const invalid = from >= to || !tr.doc.slice(from, to).eq(target.slice);
            next.set(id, { ...target, from, to, invalid });
          }
        }
        if (action?.target) next.set(action.id, action.target);
        else if (action) next.delete(action.id);
        return next;
      },
    },
  })],
}));

export function trackAISelection(view: EditorView, from: number, to: number, protection: ProtectedSelection) {
  view.dispatch(view.state.tr.setMeta(targetKey, {
    id: protection.namespace,
    target: { from, to, slice: view.state.doc.slice(from, to), invalid: false },
  } satisfies TargetAction));
}

export function releaseAISelection(view: EditorView | undefined, protection: ProtectedSelection) {
  if (!view || view.isDestroyed) return;
  view.dispatch(view.state.tr.setMeta(targetKey, { id: protection.namespace } satisfies TargetAction));
}

/** Used by both popup Accept and automatically completed selection reviews. */
export function applyAISelection(view: EditorView | undefined, protection: ProtectedSelection, response: string): string | null {
  if (!view || view.isDestroyed) return "원래 편집기가 닫혀 문서를 변경하지 않았습니다.";
  try {
    const target = targetKey.getState(view.state)?.get(protection.namespace);
    if (!target) return "원래 선택 영역을 찾을 수 없어 문서를 변경하지 않았습니다. 다시 선택해 실행해 주세요.";
    if (target.invalid || !view.state.doc.slice(target.from, target.to).eq(target.slice)) {
      return "AI 응답을 기다리는 동안 선택 영역의 내용이나 서식이 변경되어 자동 교체를 중단했습니다. 해당 부분을 다시 선택해 실행해 주세요.";
    }
    const replacement = restoreProtectedSelection(view.state.schema, protection, response);
    const tr = view.state.tr.replace(target.from, target.to, replacement);
    const end = target.from + replacement.size;
    tr.setSelection(TextSelection.between(tr.doc.resolve(target.from), tr.doc.resolve(end)));
    tr.setMeta(targetKey, { id: protection.namespace } satisfies TargetAction);
    view.dispatch(tr.scrollIntoView());
    if (!view.state.doc.slice(target.from, end).eq(tr.doc.slice(target.from, end))) {
      return "편집기에 수정안이 반영됐는지 확인하지 못했습니다. 현재 선택 영역을 확인해 주세요.";
    }
    view.focus();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "AI 수정안을 적용하지 못했습니다.";
  }
}
