import { createExtension, type BlockNoteEditor } from "@blocknote/core";
import { nextSuggestionId, readableHunks, revisedInline, sentenceHunks, suggestReplacement } from "../../../shared/collab/suggested-edits";
import { CHANGE_SETS_MAP, type ChangeSetInfo } from "../../../shared/collab/change-sets";
import { SCHOLARPEN_AI } from "../../../shared/collab/personas";
import { getEditorCollab } from "../../collab/editor-collab";
import { listChangeSets } from "../../collab/suggestions";
import type { Mark, Slice } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { restoreProtectedSelection, type ProtectedSelection } from "./ai-inline-edit-protection";
import { AI_AUTHORED_META, authorshipBlindSlice } from "../../../shared/collab/ai-authorship";

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

/** Apply an explicitly accepted edit, or stage a protected rewrite for collaborative review. */
export function applyAISelection(view: EditorView | undefined, protection: ProtectedSelection, response: string, suggestionId?: number): string | null {
  if (!view || view.isDestroyed) return "원래 편집기가 닫혀 문서를 변경하지 않았습니다.";
  try {
    const target = targetKey.getState(view.state)?.get(protection.namespace);
    if (!target) return "원래 선택 영역을 찾을 수 없어 문서를 변경하지 않았습니다. 다시 선택해 실행해 주세요.";
    if (target.invalid || !view.state.doc.slice(target.from, target.to).eq(target.slice)) {
      return "AI 응답을 기다리는 동안 선택 영역의 내용이나 서식이 변경되어 수정안 적용을 중단했습니다. 해당 부분을 다시 선택해 실행해 주세요.";
    }
    const replacement = restoreProtectedSelection(view.state.schema, protection, response);
    const tr = view.state.tr;
    let pending = false;
    target.slice.content.descendants((node) => {
      if (node.marks.some(mark => ["insertion", "deletion", "modification"].includes(mark.type.name))) pending = true;
    });
    if (suggestionId !== undefined && pending) return "선택 영역에 검토 중인 수정안이 있습니다. 먼저 Accept 또는 Reject로 결정한 뒤 다시 실행해 주세요.";
    // Text runs are read as the model saw them. A suggestion is reviewed sentence by sentence; an accepted
    // edit lands word by word. Either way kept words keep their marks and only the AI's words carry its authorship.
    const hunksOf = suggestionId !== undefined ? sentenceHunks : readableHunks;
    const revisedTexts: string[] = [];
    replacement.content.descendants(node => { if (node.isText) revisedTexts.push(node.text!); });
    const edits: Array<{ from: number; to: number; original: string; insert: string; marks: readonly Mark[] }> = [];
    let index = 0;
    const blind = authorshipBlindSlice(target.slice);
    blind.content.descendants((node, pos) => {
      if (!node.isText) return;
      const offset = target.from + pos - blind.openStart;
      for (const hunk of hunksOf(node.text!, revisedTexts[index++] ?? node.text!)) {
        edits.push({ from: offset + hunk.from, to: offset + hunk.to, original: node.text!.slice(hunk.from, hunk.to), insert: hunk.insert, marks: node.marks });
      }
    });
    for (const edit of edits.reverse()) {
      const content = revisedInline(tr.doc, edit.from, edit.original, edit.insert, edit.marks);
      if (suggestionId !== undefined) suggestReplacement(tr, edit.from, edit.to, content, suggestionId);
      else if (content.length) tr.replaceWith(edit.from, edit.to, content);
      else tr.delete(edit.from, edit.to);
    }
    tr.setMeta(AI_AUTHORED_META, true);
    const end = tr.mapping.map(target.to, 1);
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

/** Same marks, metadata and Accept/Reject controls as edits from the AI collaborator. */
export function suggestAISelection(editor: BlockNoteEditor<any, any, any>, protection: ProtectedSelection, response: string, label: string) {
  const view = editor.prosemirrorView;
  if (!view || view.isDestroyed) return "원래 편집기가 닫혀 문서를 변경하지 않았습니다.";
  const id = nextSuggestionId(view.state.doc);
  const error = applyAISelection(view, protection, response, id);
  if (!error && listChangeSets(view.state.doc).some(set => set.id === id)) {
    getEditorCollab(editor)?.ydoc.getMap<ChangeSetInfo>(CHANGE_SETS_MAP).set(String(id), {
      id, label, persona: SCHOLARPEN_AI.id, createdAt: Date.now(),
    });
  }
  return error;
}
