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
import type { LLMProvider, OllamaStatus, AppSettings } from "@shared/rpc-types";

interface SettingsPageProps {
  ollamaStatus: OllamaStatus;
  onClose: () => void;
  onSettingsSaved?: (saved: AppSettings) => void;
}

const PROVIDERS: Array<{ value: LLMProvider; label: string }> = [
  { value: "ollama", label: "Ollama" },
  { value: "anthropic", label: "Claude" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openai", label: "OpenAI" },
];

const MODEL_PRESETS: Record<Exclude<LLMProvider, "ollama">, string[]> = {
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  openai: ["gpt-5.2", "gpt-5.1", "gpt-4.1"],
};

const DEFAULT_PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  ollama: [],
  ...MODEL_PRESETS,
};

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

function ProviderModelPicker({
  models,
  value,
  placeholder,
  loading,
  error,
  onRefresh,
  onChange,
}: {
  models: string[];
  value: string;
  placeholder: string;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onChange: (model: string) => void;
}) {
  const hasValueInList = models.includes(value);

  return (
    <div className="space-y-1.5">
      {models.length > 0 && (
        <Select
          value={hasValueInList ? value : "custom"}
          onValueChange={(next) => {
            if (next !== "custom") onChange(next);
          }}
        >
          <SelectTrigger className="text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model} value={model} className="text-xs font-mono">
                {model}
              </SelectItem>
            ))}
            <SelectItem value="custom" className="text-xs">
              Custom model ID
            </SelectItem>
          </SelectContent>
        </Select>
      )}
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-muted-foreground"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw className={cn("h-3 w-3 mr-1", loading && "animate-spin")} />
          모델 새로고침
        </Button>
        {models.length > 0 && <span className="text-[11px] text-muted-foreground">{models.length} models</span>}
      </div>
      {error && <p className="text-[11px] leading-relaxed text-destructive">{error}</p>}
    </div>
  );
}

export function SettingsPage({ ollamaStatus, onClose, onSettingsSaved }: SettingsPageProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<LLMProvider, string[]>>(DEFAULT_PROVIDER_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelListError, setModelListError] = useState<string | null>(null);

  useEffect(() => {
    rpc.getSettings().then(setSettings).catch(console.error);
  }, []);

  const fetchProviderModels = useCallback(async (providerToFetch: LLMProvider, currentSettings = settings) => {
    if (!currentSettings) return;
    setLoadingModels(true);
    setModelListError(null);
    try {
      const models = await rpc.listProviderModels(providerToFetch, currentSettings);
      setProviderModels((prev) => ({ ...prev, [providerToFetch]: models }));
      if (models.length > 0 && providerToFetch === currentSettings.sidebarAgentProvider) {
        const activeModel = currentSettings.sidebarAgentModel;
        if (!activeModel || !models.includes(activeModel)) {
          updateProviderModelForSettings(providerToFetch, models[0], currentSettings);
        }
      }
    } catch (err) {
      setModelListError((err as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }, [settings]);

  // Fetch ollama model list on mount (or when switching to ollama)
  useEffect(() => {
    if (!settings) return;
    const provider = settings.sidebarAgentProvider ?? "ollama";
    const hasCredentials =
      provider === "ollama" ||
      (provider === "anthropic" && settings.anthropicApiKey.trim()) ||
      (provider === "deepseek" && settings.deepseekApiKey.trim()) ||
      (provider === "openai" && settings.openaiApiKey.trim());
    if (hasCredentials) fetchProviderModels(provider, settings);
  }, [settings?.sidebarAgentProvider]);

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

  const provider = settings.sidebarAgentProvider ?? "ollama";

  const updateProviderModelForSettings = (targetProvider: LLMProvider, model: string, currentSettings = settings) => {
    const nextProviders = {
      ...currentSettings.modelProviders,
      [targetProvider]: {
        ...currentSettings.modelProviders[targetProvider],
        model,
      },
    };
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sidebarAgentModel: model,
        ollamaDefaultModel: targetProvider === "ollama" ? model : prev.ollamaDefaultModel,
        anthropicDefaultModel: targetProvider === "anthropic" ? model : prev.anthropicDefaultModel,
        deepseekDefaultModel: targetProvider === "deepseek" ? model : prev.deepseekDefaultModel,
        openaiDefaultModel: targetProvider === "openai" ? model : prev.openaiDefaultModel,
        modelProviders: nextProviders,
      };
    });
    setSaved(false);
  };

  const updateProviderModel = (model: string) => {
    updateProviderModelForSettings(provider, model);
  };

  const modelsForProvider = providerModels[provider] ?? [];
  const currentModel = settings.sidebarAgentModel || settings.modelProviders[provider]?.model || settings.ollamaDefaultModel;

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

            {/* Provider toggle */}
            <SettingRow label="Sidebar Provider" description="AISidebar에서 사용할 LLM provider">
              <div className="grid grid-cols-4 rounded-md border border-border bg-muted/30 p-0.5">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => {
                      const model = settings.modelProviders[p.value]?.model;
                      updateSetting("sidebarAgentProvider", p.value);
                      if (model) updateSetting("sidebarAgentModel", model);
                    }}
                    className={cn(
                      "rounded-[5px] px-2 py-1.5 text-[11px] font-medium transition-colors",
                      provider === p.value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-background hover:text-foreground"
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </SettingRow>

            {/* Ollama model */}
            {provider === "ollama" && (
              <>
                <SettingRow
                  label="Ollama Base URL"
                  description="Ollama status, model lookup, sidebar agent에 사용"
                >
                  <Input
                    value={settings.ollamaBaseUrl}
                    onChange={(e) => {
                      updateSetting("ollamaBaseUrl", e.target.value);
                      updateSetting("modelProviders", {
                        ...settings.modelProviders,
                        ollama: { ...settings.modelProviders.ollama, baseUrl: e.target.value },
                      });
                    }}
                    placeholder="http://localhost:11434"
                    className="font-mono text-xs"
                  />
                </SettingRow>

                <SettingRow label="Sidebar Agent Model" description="Ollama에서 설치된 모델 목록을 불러옵니다">
                  <ProviderModelPicker
                    models={modelsForProvider}
                    value={currentModel}
                    placeholder="qwen3.5:cloud"
                    loading={loadingModels}
                    error={modelListError}
                    onRefresh={() => fetchProviderModels(provider, settings)}
                    onChange={updateProviderModel}
                  />
                </SettingRow>
              </>
            )}

            {provider !== "ollama" && (
              <>
                <SettingRow
                  label={`${PROVIDERS.find((p) => p.value === provider)?.label} API Key`}
                  description="Bun main process에서만 사용됩니다"
                >
                  <Input
                    type="password"
                    value={
                      provider === "anthropic"
                        ? settings.anthropicApiKey
                        : provider === "deepseek"
                          ? settings.deepseekApiKey
                          : settings.openaiApiKey
                    }
                    onChange={(e) => {
                      if (provider === "anthropic") updateSetting("anthropicApiKey", e.target.value);
                      if (provider === "deepseek") updateSetting("deepseekApiKey", e.target.value);
                      if (provider === "openai") updateSetting("openaiApiKey", e.target.value);
                    }}
                    placeholder="Enter API key..."
                    className="font-mono text-xs"
                  />
                </SettingRow>

                {provider !== "anthropic" && (
                  <SettingRow label="Base URL" description="OpenAI-compatible endpoint">
                    <Input
                      value={provider === "deepseek" ? settings.deepseekBaseUrl : settings.openaiBaseUrl}
                      onChange={(e) => {
                        if (provider === "deepseek") {
                          updateSetting("deepseekBaseUrl", e.target.value);
                          updateSetting("modelProviders", {
                            ...settings.modelProviders,
                            deepseek: { ...settings.modelProviders.deepseek, baseUrl: e.target.value },
                          });
                        }
                        if (provider === "openai") {
                          updateSetting("openaiBaseUrl", e.target.value);
                          updateSetting("modelProviders", {
                            ...settings.modelProviders,
                            openai: { ...settings.modelProviders.openai, baseUrl: e.target.value },
                          });
                        }
                      }}
                      className="font-mono text-xs"
                    />
                  </SettingRow>
                )}

                <SettingRow label="Sidebar Agent Model" description="Provider API에서 모델 목록을 불러옵니다">
                  <ProviderModelPicker
                    models={modelsForProvider.length > 0 ? modelsForProvider : MODEL_PRESETS[provider]}
                    value={currentModel}
                    placeholder={MODEL_PRESETS[provider][0]}
                    loading={loadingModels}
                    error={modelListError}
                    onRefresh={() => fetchProviderModels(provider, settings)}
                    onChange={updateProviderModel}
                  />
                </SettingRow>
              </>
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

          <Separator />

          {/* Knowledge Base */}
          <SettingSection icon={BookOpen} title="Knowledge Base">
            <SettingRow
              label="Search Results"
              description="Number of KB pages injected into AI context"
            >
              <Input
                type="number"
                min={1}
                max={20}
                value={settings.kbTopK}
                onChange={(e) => updateSetting("kbTopK", Math.max(1, Math.min(20, Number(e.target.value) || 5)))}
                className="font-mono text-xs"
              />
            </SettingRow>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Chunk size, chunk overlap, and embed model are planned for Phase 4 hybrid RAG. Current KB search uses page-level FTS.
            </div>
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
