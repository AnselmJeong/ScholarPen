import React, { useEffect, useState } from "react";
import { Switch } from "../components/ui/switch";
import { initializeExtensionsUI, prepareExtensionDisable, setExtensionEnabled, useExtensions } from "./state";
export function ExtensionSettings() {
  const extensions = useExtensions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void initializeExtensionsUI(); }, []);
  async function toggle(id: string, enabled: boolean) {
    setBusy(id); setError(null);
    try {
      if (!enabled) await prepareExtensionDisable(id);
      await setExtensionEnabled(id, enabled);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save extension state."); }
    finally { setBusy(null); }
  }
  return <section aria-label="Extensions" className="space-y-3">
    <h3 className="text-sm font-semibold">Extensions</h3>
    <p className="text-xs text-muted-foreground">변경은 즉시 저장됩니다. 기능을 꺼도 문서와 기존 결과는 보존됩니다.</p>
    {extensions.map(info => <div key={info.manifest.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1"><label htmlFor={info.manifest.id} className="text-sm font-medium">{info.manifest.name}</label>
        <p className="text-xs text-muted-foreground break-words">{info.manifest.description}</p>
        {info.error && <p className="text-xs text-amber-700">{info.error}</p>}
      </div>
      <Switch id={info.manifest.id} checked={info.enabled} disabled={busy !== null} onCheckedChange={enabled => void toggle(info.manifest.id, enabled)} />
    </div>)}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
