import React, { useEffect, useState } from "react";
import type { CollabPeer } from "../../collab/collab-peer";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { rpc } from "../../rpc";
import { PanelError, PanelNote } from "./panel-kit";
import {
  PROJECT_REVIEW_SETTINGS_KEY,
  REVIEW_CATEGORIES,
  REVIEW_MAP,
  normalizeReviewCategories,
  type ProjectReviewSettings,
  type ReviewCategory,
} from "../../../shared/collab/review";

export function ProjectReviewOptions({ collab }: { collab: Pick<CollabPeer, "docKey" | "ydoc"> }) {
  const [disabled, setDisabled] = useState<ReviewCategory[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const map = collab.ydoc.getMap(REVIEW_MAP);
    const refresh = () => {
      const settings = map.get(PROJECT_REVIEW_SETTINGS_KEY) as ProjectReviewSettings | undefined;
      setDisabled(settings ? normalizeReviewCategories(settings.disabledCategories) : null);
    };
    refresh();
    map.observe(refresh);
    return () => map.unobserve(refresh);
  }, [collab]);

  const toggle = async (category: ReviewCategory, enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      // Bun saves first, then broadcasts the authoritative policy to every open editor.
      await rpc.collabSetReviewCategory(collab.docKey, category, enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="rounded-md border border-sidebar-border bg-background">
      <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">
        Comment types · Project
        {disabled && <span className="ml-2 font-normal text-muted-foreground">{REVIEW_CATEGORIES.length - disabled.length}/{REVIEW_CATEGORIES.length} on</span>}
      </summary>
      <div className="space-y-2 px-2 pb-2">
        <PanelNote>
          Applies to every document in this project. Turning a type off stops new comments and hides its open ones from the list; they are kept, not resolved.
        </PanelNote>
        <fieldset disabled={saving || disabled === null} className="max-h-72 space-y-2 overflow-y-auto">
          <legend className="sr-only">Project comment types</legend>
          {REVIEW_CATEGORIES.map(category => (
            <CheckboxInput key={category.id} size="sm" label={category.label} description={category.description}
              value={disabled !== null && !disabled.includes(category.id)} isDisabled={saving || disabled === null}
              onChange={checked => void toggle(category.id, checked)} />
          ))}
        </fieldset>
        {disabled?.length === REVIEW_CATEGORIES.length && <PanelNote>All types are off. Automatic comments are paused.</PanelNote>}
        {saving && <PanelNote role="status">Saving project settings…</PanelNote>}
        {error && <PanelError>{error}</PanelError>}
      </div>
    </details>
  );
}
