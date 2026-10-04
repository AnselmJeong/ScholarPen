import React, { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { ChevronDown, ChevronRight, PenLine } from "lucide-react";
import { rpc } from "../../rpc";
import { getEditorCollab } from "../../collab/editor-collab";
import { ZONE_LABEL, ZONES_MAP, setZone, zoneOf, type Zone, type ZoneTrust } from "../../../shared/collab/zones";

interface HeadingItem {
  id: string;
  title: string;
  level: number;
}

function useHeadings(editor: BlockNoteEditor<any, any, any>) {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  useEffect(() => {
    const refresh = () => setHeadings(editor.document
      .filter((block: any) => block.type === "heading")
      .map((block: any) => ({
        id: block.id,
        title: (block.content ?? []).map((part: any) => part.text ?? "").join("").trim() || "Untitled section",
        level: block.props?.level ?? 1,
      })));
    refresh();
    return editor.onChange(refresh);
  }, [editor]);
  return headings;
}

function useZones(editor: BlockNoteEditor<any, any, any>) {
  const collab = getEditorCollab(editor);
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (!collab) return;
    const map = collab.ydoc.getMap<Zone>(ZONES_MAP);
    const refresh = () => setVersion((value) => value + 1);
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [collab]);
  return collab ? collab.ydoc.getMap<Zone>(ZONES_MAP) : null;
}

/**
 * Per-section agreements with the AI: observe only, suggest edits, or let it
 * draft and edit directly (e.g. "the AI drafts Methods from my notes; I write
 * the Introduction").
 */
export function ZonesSection({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const collab = getEditorCollab(editor);
  const headings = useHeadings(editor);
  const zones = useZones(editor);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!collab || !zones || headings.length === 0) return null;
  const configured = headings.filter((heading) => zoneOf(zones, heading.id).trust !== "auto").length;

  const update = (id: string, patch: Partial<Zone>) => {
    collab.ydoc.transact(() => setZone(zones, id, { ...zoneOf(zones, id), ...patch }));
  };
  const draft = (id: string) => {
    setError(null);
    rpc.collabDraftSection(collab.docKey, id)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };
  const scrollTo = (id: string) => {
    editor.setTextCursorPosition(id, "end");
    editor.focus();
  };

  return (
    <div className="border-b border-border">
      <button type="button" onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[11px] font-medium text-foreground hover:bg-muted/50">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Work zones
        <span className="ml-1 font-normal text-muted-foreground">
          {configured > 0 ? `${configured} of ${headings.length} sections set` : "AI may suggest anywhere"}
        </span>
      </button>
      {open && (
        <div className="pb-2">
          {headings.map((heading) => {
            const zone = zoneOf(zones, heading.id);
            return (
              <div key={heading.id} className="px-3 py-1" style={{ paddingLeft: `${12 + (heading.level - 1) * 10}px` }}>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => scrollTo(heading.id)}
                    className="min-w-0 flex-1 truncate text-left text-[11px] text-foreground hover:underline">
                    {heading.title}
                  </button>
                  <select value={zone.trust} aria-label={`AI trust for ${heading.title}`}
                    onChange={(event) => update(heading.id, { trust: event.target.value as ZoneTrust })}
                    className="rounded border border-border bg-background px-1 py-0.5 text-[11px]">
                    {(["auto", "observe", "suggest", "edit"] as ZoneTrust[]).map((trust) => (
                      <option key={trust} value={trust}>{ZONE_LABEL[trust]}</option>
                    ))}
                  </select>
                </div>
                {zone.trust === "edit" && (
                  <div className="mt-1 flex items-start gap-1">
                    <textarea
                      defaultValue={zone.brief ?? ""}
                      placeholder="What should this section say? (optional; the AI also uses your notes in the section)"
                      onBlur={(event) => update(heading.id, { brief: event.target.value.trim() || undefined })}
                      rows={2}
                      className="min-w-0 flex-1 resize-y rounded border border-border bg-background px-1.5 py-1 text-[11px] leading-4"
                    />
                    <button type="button" onClick={() => draft(heading.id)} title="Draft this section from your notes"
                      className="flex items-center gap-1 rounded border border-border px-1.5 py-1 text-[11px] text-violet-700 hover:bg-violet-500/10">
                      <PenLine className="h-3 w-3" /> Draft
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {error && <p className="px-3 pt-1 text-[11px] text-red-600">{error}</p>}
          <p className="px-3 pt-1 text-[10px] leading-4 text-muted-foreground">
            Observe: comments only. Suggest: every edit is a tracked suggestion. AI drafts: edits apply directly and the AI can draft from your notes. Auto: typo fixes apply, other edits are suggested.
          </p>
        </div>
      )}
    </div>
  );
}
