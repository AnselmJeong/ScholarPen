import { useSyncExternalStore } from "react";

/** View preference: highlight text ScholarPen AI wrote (the `aiAuthored` mark). Off by default. */
const STORAGE_KEY = "scholarpen.editor-ai-authorship-visible";
const CHANGE_EVENT = "scholarpen-ai-authorship-visibility";
let fallback = false;

function readVisibility(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return fallback; }
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setAuthorshipVisible(visible: boolean) {
  fallback = visible;
  try { localStorage.setItem(STORAGE_KEY, String(visible)); } catch { /* View preference is optional. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useAuthorshipVisibility() {
  return useSyncExternalStore(subscribe, readVisibility, () => false);
}
