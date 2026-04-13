import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Folder, Bot, BookOpen, RefreshCw, Sun } from "lucide-react";
import { applyTheme } from "../../main";
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
import { cn } from "@/lib/utils";
import { rpc } from "../../rpc";
import type { OllamaStatus, AppSettings } from "@shared/rpc-types";

interface SettingsPageProps {
  ollamaStatus: OllamaStatus;
  onClose: () => void;
  onSettingsSaved?: (saved: AppSettings) => void;
}

const CLAUDE_MODELS = [
  { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

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
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    rpc.getSettings().then(setSettings).catch(console.error);
  }, []);

  const fetchOllamaModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const models = await rpc.getOllamaModels();
      setOllamaModels(models);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  // Fetch ollama model list on mount (or when switching to ollama)
  useEffect(() => {
    if (settings?.aiBackend !== "claude") {
      fetchOllamaModels();
    }
  }, [settings?.aiBackend]);

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
      applyTheme(settings.theme ?? "system");
      setSaved(true);
      onSettingsSaved?.(settings);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  }, [settings, onSettingsSaved]);

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

  const backend = settings.aiBackend ?? "ollama";

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

          {/* AI section */}
          <SettingSection icon={Bot} title="AI">

            {/* Backend toggle */}
            <SettingRow label="Backend" description="AI 응답 방식">
              <div className="flex rounded-lg border border-border overflow-hidden">
                {(["ollama", "claude"] as const).map((b) => (
                  <button
                    key={b}
                    onClick={() => updateSetting("aiBackend", b)}
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium transition-colors",
                      backend === b
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {b === "ollama" ? "Ollama" : "Claude (직접)"}
                  </button>
                ))}
              </div>
            </SettingRow>

            {/* Ollama model */}
            {backend === "ollama" && (
              <SettingRow
                label="Ollama Model"
                description="ollama launch claude 로 실행할 모델"
              >
                <div className="space-y-1.5">
                  {ollamaModels.length > 0 ? (
                    <Select
                      value={settings.ollamaDefaultModel}
                      onValueChange={(v) => updateSetting("ollamaDefaultModel", v)}
                    >
                      <SelectTrigger className="text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ollamaModels.map((m) => (
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
                      placeholder="glm-5.1:cloud"
                      className="font-mono text-xs"
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={fetchOllamaModels}
                    disabled={loadingModels}
                  >
                    <RefreshCw className={cn("h-3 w-3 mr-1", loadingModels && "animate-spin")} />
                    목록 새로고침
                  </Button>
                </div>
              </SettingRow>
            )}

            {/* Claude direct model */}
            {backend === "claude" && (
              <SettingRow
                label="Claude Model"
                description="Anthropic API를 통해 직접 실행"
              >
                <Select
                  value={settings.claudeModel ?? "claude-sonnet-4-6"}
                  onValueChange={(v) => updateSetting("claudeModel", v)}
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLAUDE_MODELS.map(({ value, label }) => (
                      <SelectItem key={value} value={value} className="text-xs">
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            )}

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

          {/* Appearance */}
          <SettingSection icon={Sun} title="Appearance">
            <SettingRow label="Theme" description="앱 색상 테마">
              <div className="flex rounded-lg border border-border overflow-hidden">
                {(["light", "dark", "system"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => updateSetting("theme", t)}
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium transition-colors capitalize",
                      (settings.theme ?? "system") === t
                        ? "bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:bg-muted"
                    )}
                  >
                    {t === "light" ? "Light" : t === "dark" ? "Dark" : "System"}
                  </button>
                ))}
              </div>
            </SettingRow>
          </SettingSection>

          <Separator />

          {/* Citations */}
          <SettingSection icon={BookOpen} title="Citations">
            <SettingRow
              label="OpenAlex API Key"
              description="Optional — increases rate limits. Get yours at openalex.org/account"
            >
              <Input
                type="password"
                value={settings.openAlexApiKey}
                onChange={(e) => updateSetting("openAlexApiKey", e.target.value)}
                placeholder="Enter API key…"
                className="font-mono text-xs"
              />
            </SettingRow>
          </SettingSection>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-border px-8 py-4 flex items-center justify-between">
        <span className={`text-xs transition-opacity ${saved ? "opacity-100 text-emerald-600" : "opacity-0"}`}>
          Settings saved
        </span>
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
