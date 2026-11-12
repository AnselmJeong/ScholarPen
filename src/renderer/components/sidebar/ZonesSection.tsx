import React, { useEffect, useState } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { PenLine, Shield } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { rpc } from "../../rpc";
import { PanelError, PanelNote, PanelSection } from "./panel-kit";
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

  const trustOptions = (["auto", "observe", "suggest", "edit"] as ZoneTrust[]).map((trust) => ({ value: trust, label: ZONE_LABEL[trust] }));
  return (
    <PanelSection title="Work zones" icon={Shield}
      summary={configured > 0 ? `${configured} of ${headings.length} sections set` : "AI may suggest anywhere"}>
      {headings.map((heading) => {
        const zone = zoneOf(zones, heading.id);
        return (
          <div key={heading.id} className="space-y-1" style={{ paddingLeft: `${(heading.level - 1) * 10}px` }}>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => scrollTo(heading.id)}
                className="min-w-0 flex-1 truncate text-left text-xs text-foreground hover:underline">
                {heading.title}
              </button>
              <div className="w-36 shrink-0">
                <Selector label={`AI trust for ${heading.title}`} isLabelHidden size="sm" value={zone.trust} options={trustOptions}
                  onChange={(value) => { if (value) update(heading.id, { trust: value as ZoneTrust }); }} />
              </div>
            </div>
            {zone.trust === "edit" && (
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1">
                  <ZoneBrief initial={zone.brief ?? ""} onCommit={(brief) => update(heading.id, { brief: brief.trim() || undefined })} />
                </div>
                <Button label="Draft" size="sm" variant="secondary" tooltip="Draft this section from your notes"
                  icon={<PenLine className="h-3 w-3" aria-hidden />} onClick={() => draft(heading.id)} />
              </div>
            )}
          </div>
        );
      })}
      {error && <PanelError>{error}</PanelError>}
      <PanelNote>
        Observe: comments only. Suggest: every edit is a tracked suggestion. AI drafts: edits apply directly and the AI can draft from your notes. Auto: typo fixes apply, other edits are suggested.
      </PanelNote>
    </PanelSection>
  );
}

/** The section brief; saved when the field loses focus, like the notes it accompanies. */
function ZoneBrief({ initial, onCommit }: { initial: string; onCommit: (brief: string) => void }) {
  const [value, setValue] = useState(initial);
  useEffect(() => { setValue(initial); }, [initial]);
  return (
    <div onBlur={() => { if (value !== initial) onCommit(value); }}>
      <TextArea label="Section brief" isLabelHidden rows={2} value={value} onChange={setValue}
        placeholder="What should this section say? (optional; the AI also uses your notes in the section)" />
    </div>
  );
}
