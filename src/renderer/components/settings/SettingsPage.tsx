import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Server, Folder, Database, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { rpc } from "../../rpc";
import type { OllamaStatus, AppSettings } from "@shared/rpc-types";

interface SettingsPageProps {
  ollamaStatus: OllamaStatus;
  onClose: () => void;
  onSettingsSaved?: () => void;
}

function SettingSection({ icon: Icon, title, children }: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      </div>
      <div className="space-y-3 pl-6">{children}</div>
    </div>
  );
}

function SettingRow({ label, description, children }: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-8">
      <div className="flex-1">
        <Label className="text-sm font-medium">{label}</Label>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="w-64 flex-shrink-0">{children}</div>
    </div>
  );
}

export function SettingsPage({ ollamaStatus, onClose, onSettingsSaved }: SettingsPageProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    rpc.getSettings().then(setSettings).catch(console.error);
  }, []);

  const updateSetting = useCallback(<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    setSettings((prev) => prev ? { ...prev, [key]: value } : prev);
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await rpc.saveSettings(settings);
      setSaved(true);
      onSettingsSaved?.();
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const handleBrowseProjectsDir = useCallback(async () => {
    const path = await rpc.openFolderDialog();
    if (path) updateSetting("projectsRootDir", path);
  }, [updateSetting]);

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border">
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-base font-semibold">Settings</h2>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-8 py-8 space-y-8">

          {/* AI / Ollama */}
          <SettingSection icon={Bot} title="AI (Ollama)">
            <SettingRow
              label="Base URL"
              description="Ollama server address"
            >
              <Input
                value={settings.ollamaBaseUrl}
                onChange={(e) => updateSetting("ollamaBaseUrl", e.target.value)}
                placeholder="http://localhost:11434"
                className="font-mono text-xs"
              />
            </SettingRow>

            <SettingRow
              label="Default Model"
              description="Used for writing assistance"
            >
              {ollamaStatus.connected && ollamaStatus.models.length > 0 ? (
                <Select
                  value={settings.ollamaDefaultModel}
                  onValueChange={(v) => updateSetting("ollamaDefaultModel", v)}
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ollamaStatus.models.map((m) => (
                      <SelectItem key={m} value={m} className="text-xs font-mono">
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={settings.ollamaDefaultModel}
                  onChange={(e) => updateSetting("ollamaDefaultModel", e.target.value)}
                  placeholder="qwen3.5:cloud"
                  className="font-mono text-xs"
                />
              )}
            </SettingRow>

            <SettingRow
              label="Embed Model"
              description="Used for knowledge base indexing"
            >
              <Input
                value={settings.ollamaEmbedModel}
                onChange={(e) => updateSetting("ollamaEmbedModel", e.target.value)}
                placeholder="nomic-embed-text"
                className="font-mono text-xs"
              />
            </SettingRow>
          </SettingSection>

          <Separator />

          {/* Storage */}
          <SettingSection icon={Folder} title="Storage">
            <SettingRow
              label="Projects Root Folder"
              description="Where new projects are created"
            >
              <div className="flex gap-2">
                <Input
                  value={settings.projectsRootDir}
                  onChange={(e) => updateSetting("projectsRootDir", e.target.value)}
                  className="font-mono text-xs flex-1 min-w-0"
                  readOnly
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-shrink-0 text-xs"
                  onClick={handleBrowseProjectsDir}
                >
                  Browse
                </Button>
              </div>
            </SettingRow>
          </SettingSection>

          <Separator />

          {/* Knowledge Base */}
          <SettingSection icon={Database} title="Knowledge Base (RAG)">
            <SettingRow
              label="Chunk Size"
              description="Token size per indexed chunk"
            >
              <Input
                type="number"
                min={128}
                max={2048}
                value={settings.kbChunkSize}
                onChange={(e) => updateSetting("kbChunkSize", Number(e.target.value))}
                className="text-xs"
              />
            </SettingRow>

            <SettingRow
              label="Chunk Overlap"
              description="Overlap tokens between chunks"
            >
              <Input
                type="number"
                min={0}
                max={512}
                value={settings.kbChunkOverlap}
                onChange={(e) => updateSetting("kbChunkOverlap", Number(e.target.value))}
                className="text-xs"
              />
            </SettingRow>

            <SettingRow
              label="Top K Results"
              description="Max results per semantic search"
            >
              <Input
                type="number"
                min={1}
                max={20}
                value={settings.kbTopK}
                onChange={(e) => updateSetting("kbTopK", Number(e.target.value))}
                className="text-xs"
              />
            </SettingRow>
          </SettingSection>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-border px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-xs transition-opacity ${saved ? "opacity-100 text-emerald-600" : "opacity-0"}`}>
            Settings saved
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      </div>
    </div>
  );
}
