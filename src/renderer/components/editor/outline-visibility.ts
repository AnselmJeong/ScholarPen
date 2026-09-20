import { useSyncExternalStore } from "react";

const STORAGE_KEY = "scholarpen.editor-outline-visible";
const CHANGE_EVENT = "scholarpen-outline-visibility";
let fallback = true;

function readVisibility(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== "false"; }
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

export function setOutlineVisible(visible: boolean) {
  fallback = visible;
  try { localStorage.setItem(STORAGE_KEY, String(visible)); } catch { /* View preference is optional. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useOutlineVisibility() {
  return useSyncExternalStore(subscribe, readVisibility, () => true);
}
