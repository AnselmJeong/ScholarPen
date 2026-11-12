import React, { useEffect, useState } from "react";
import { Switch } from "@astryxdesign/core/Switch";
import { SettingsError, SettingsSection } from "../components/settings/settings-kit";
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
  return <SettingsSection title="Plugins" label="Extensions" description="변경은 즉시 저장됩니다. 기능을 꺼도 문서와 기존 결과는 보존됩니다.">
    {extensions.map(info => <div key={info.manifest.id}>
      <Switch label={info.manifest.name} description={info.manifest.description} value={info.enabled} isDisabled={busy !== null}
        isLoading={busy === info.manifest.id} labelPosition="start" labelSpacing="spread" width="100%"
        status={info.error ? { type: "warning", message: info.error } : undefined}
        onChange={enabled => void toggle(info.manifest.id, enabled)} />
    </div>)}
    {error && <SettingsError>{error}</SettingsError>}
  </SettingsSection>;
}
