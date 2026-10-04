import { createExtension, type ExtensionOptions } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import type * as Y from "yjs";

/** Shared map Bun writes when the AI changes a block directly (no suggestion marks). */
export const AI_EDITS_MAP = "aiEdits";
const HIGHLIGHT_MS = 24 * 60 * 60 * 1000;
const key = new PluginKey<DecorationSet>("scholarpen-ai-edit-highlight");

/** Marks blocks the AI edited directly in the last day with a violet gutter. */
export const AIEditHighlightExtension = createExtension(({ options }: ExtensionOptions<{ edits: Y.Map<{ at: number }> }>) => {
  const build = (doc: Parameters<typeof DecorationSet.create>[0]) => {
    const cutoff = Date.now() - HIGHLIGHT_MS;
    const decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== "blockContainer") return true;
      const edit = options.edits.get(node.attrs.id);
      if (edit && edit.at > cutoff) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "sp-ai-edited", title: "Edited by ScholarPen AI" }));
      }
      return true;
    });
    return DecorationSet.create(doc, decorations);
  };
  return {
    key: "aiEditHighlight",
    prosemirrorPlugins: [new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, previous) => tr.docChanged || tr.getMeta(key) ? build(tr.doc) : previous,
      },
      props: { decorations: (state) => key.getState(state) },
      view: (view) => {
        const refresh = () => { if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true)); };
        options.edits.observe(refresh);
        return { destroy: () => options.edits.unobserve(refresh) };
      },
    })],
  } as const;
});
