import React, { useEffect, useState } from "react";
import type { CollabPeer } from "../../collab/collab-peer";
import { rpc } from "../../rpc";
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
    <details className="mx-3 mb-2 rounded border border-border text-xs">
      <summary className="cursor-pointer px-2 py-1.5 font-medium">
        Comment types · Project
        {disabled && <span className="ml-2 font-normal text-muted-foreground">{REVIEW_CATEGORIES.length - disabled.length}/{REVIEW_CATEGORIES.length} on</span>}
      </summary>
      <p className="px-2 pb-2 text-[11px] leading-4 text-muted-foreground">
        Applies to every document in this project. Turning a type off stops new comments; existing comments stay.
      </p>
      <fieldset disabled={saving || disabled === null} className="max-h-72 space-y-1 overflow-y-auto px-2 pb-2">
        <legend className="sr-only">Project comment types</legend>
        {REVIEW_CATEGORIES.map(category => (
          <label key={category.id} className="flex cursor-pointer items-start gap-2 rounded py-1">
            <input type="checkbox" className="mt-0.5" checked={disabled !== null && !disabled.includes(category.id)}
              aria-label={category.label} onChange={event => void toggle(category.id, event.target.checked)} />
            <span>
              <span className="block font-medium">{category.label}</span>
              <span className="block text-[11px] leading-4 text-muted-foreground">{category.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {disabled?.length === REVIEW_CATEGORIES.length && <p className="px-2 pb-2 text-[11px] text-muted-foreground">All types are off. Automatic comments are paused.</p>}
      {saving && <p className="px-2 pb-2 text-[11px] text-muted-foreground" role="status">Saving project settings…</p>}
      {error && <p className="px-2 pb-2 text-[11px] text-red-600" role="alert">{error}</p>}
    </details>
  );
}
