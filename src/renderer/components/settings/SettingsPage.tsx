import { WritingPreferencesPanel } from "./WritingPreferencesPanel";
import { ExtensionSettings } from "../../extensions/ExtensionSettings";
import { ExtensionSlot } from "../../extensions/slots";
import { ClaudeConnection } from "./ClaudeConnection";
import React, { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Bot, BookOpen, PenLine, Puzzle, SlidersHorizontal, RefreshCw } from "lucide-react";
import { applyTheme } from "../../main";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Field } from "@astryxdesign/core/Field";
import { Layout, LayoutContent, LayoutFooter, LayoutHeader, LayoutPanel } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { StackItem } from "@astryxdesign/core/Layout";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { rpc } from "../../rpc";
import type { LLMProvider, OllamaStatus, AppSettings } from "@shared/rpc-types";
import { CodexConnection } from "./CodexConnection";
import { DEFAULT_OLLAMA_BASE_URL } from "@shared/ollama-connection";
import { ExternalLink, SettingsError, SettingsNote, SettingsSection } from "./settings-kit";

interface SettingsPageProps {
  ollamaStatus: OllamaStatus;
  onClose: () => void;
  onSettingsSaved?: (saved: AppSettings) => void;
}

const PROVIDERS: Array<{ value: LLMProvider; label: string }> = [
  { value: "ollama", label: "Ollama" },
  { value: "anthropic", label: "Claude 구독" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openai", label: "OpenAI" },
  { value: "codex", label: "Codex" },
];

const MODEL_PRESETS: Record<Exclude<LLMProvider, "ollama" | "codex" | "anthropic">, string[]> = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  openai: ["gpt-5.2", "gpt-5.1", "gpt-4.1"],
};

const DEFAULT_PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  ollama: [],
  codex: [],
  anthropic: [],
  ...MODEL_PRESETS,
};

type SettingsPane = "general" | "ai" | "citations" | "writing" | "extensions";

const PANES: Array<{ id: SettingsPane; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "ai", label: "AI", icon: Bot },
  { id: "citations", label: "Citations", icon: BookOpen },
  { id: "writing", label: "Writing", icon: PenLine },
  { id: "extensions", label: "Extensions", icon: Puzzle },
];

const CUSTOM_MODEL = "__custom__";

function ProviderModelPicker({
  label,
  description,
  models,
  value,
  placeholder,
  loading,
  error,
  onRefresh,
  onChange,
}: {
  label: string;
  description: string;
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
    <VStack gap={2}>
      {models.length > 0 && (
        <Selector
          label={label}
          description={description}
          hasSearch={models.length > 8}
          value={hasValueInList ? value : CUSTOM_MODEL}
          onChange={(next) => { if (next && next !== CUSTOM_MODEL) onChange(next); }}
          options={[...models.map((model) => ({ value: model, label: model })), { type: "divider" as const }, { value: CUSTOM_MODEL, label: "Custom model ID" }]}
        />
      )}
      <TextInput
        label={models.length > 0 ? "Model ID" : label}
        description={models.length > 0 ? undefined : description}
        isLabelHidden={models.length > 0}
        value={value}
        onChange={(next) => onChange(next)}
        placeholder={placeholder}
        hasSpellCheck={false}
      />
      <HStack gap={2} vAlign="center" hAlign="between">
        <Button label="모델 새로고침" variant="ghost" size="sm" isLoading={loading} onClick={onRefresh}
          icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} />
        {models.length > 0 && <Text type="supporting">{models.length} models</Text>}
      </HStack>
      {error && <SettingsError>{error}</SettingsError>}
    </VStack>
  );
}

export function SettingsPage({ ollamaStatus, onClose, onSettingsSaved }: SettingsPageProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<LLMProvider, string[]>>(DEFAULT_PROVIDER_MODELS);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelListError, setModelListError] = useState<string | null>(null);
  const [pane, setPane] = useState<SettingsPane>("general");

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
          updateProviderModelForSettings(providerToFetch, models[0]);
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
      (provider === "ollama" && settings.ollamaApiKey.trim()) ||
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
      <div className="flex flex-1 items-center justify-center bg-background">
        <Text type="supporting">Loading settings...</Text>
      </div>
    );
  }

  const provider = settings.sidebarAgentProvider ?? "ollama";

  const updateProviderModelForSettings = (targetProvider: LLMProvider, model: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sidebarAgentModel: prev.sidebarAgentProvider === targetProvider ? model : prev.sidebarAgentModel,
        ollamaDefaultModel: targetProvider === "ollama" ? model : prev.ollamaDefaultModel,
        anthropicDefaultModel: targetProvider === "anthropic" ? model : prev.anthropicDefaultModel,
        deepseekDefaultModel: targetProvider === "deepseek" ? model : prev.deepseekDefaultModel,
        openaiDefaultModel: targetProvider === "openai" ? model : prev.openaiDefaultModel,
        modelProviders: {
          ...prev.modelProviders,
          [targetProvider]: { ...prev.modelProviders[targetProvider], model },
        },
      };
    });
    setSaved(false);
  };

  const updateProviderModel = (model: string) => {
    updateProviderModelForSettings(provider, model);
  };

  const modelsForProvider = providerModels[provider] ?? [];
  const currentModel = settings.sidebarAgentModel || settings.modelProviders[provider]?.model || settings.ollamaDefaultModel;

  const providerLabel = PROVIDERS.find((p) => p.value === provider)?.label;

  const generalPane = (
    <>
      <SettingsSection title="Appearance">
        <Field label="Theme" inputID="settings-theme" description="앱 색상 테마" isGroupLabel>
          <SegmentedControl label="Theme" value={settings.theme ?? "system"} onChange={(t) => updateSetting("theme", t as AppSettings["theme"])}>
            <SegmentedControlItem value="light" label="Light" />
            <SegmentedControlItem value="dark" label="Dark" />
            <SegmentedControlItem value="system" label="System" />
          </SegmentedControl>
        </Field>
      </SettingsSection>
      <SettingsSection title="Storage">
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <TextInput label="Projects Root Folder" description="Where new projects are created" value={settings.projectsRootDir}
              onChange={(value) => updateSetting("projectsRootDir", value)} isReadOnly />
          </StackItem>
          <Button label="Browse" variant="secondary" onClick={handleBrowseProjectsDir} />
        </HStack>
      </SettingsSection>
    </>
  );

  const aiPane = (
    <>
      <SettingsSection title="Sidebar agent" description="AISidebar에서 사용할 LLM provider와 모델">
        <Field label="Sidebar Provider" inputID="settings-provider" isGroupLabel>
          <SegmentedControl label="Sidebar Provider" value={provider} onChange={(next) => {
            const value = next as LLMProvider;
            const model = settings.modelProviders[value]?.model;
            updateSetting("sidebarAgentProvider", value);
            updateSetting("sidebarAgentModel", model ?? "");
          }}>
            {PROVIDERS.map((p) => <SegmentedControlItem key={p.value} value={p.value} label={p.label} />)}
          </SegmentedControl>
        </Field>

        {provider === "codex" && <CodexConnection model={settings.sidebarAgentModel} onModelChange={updateProviderModel} />}

        {provider === "anthropic" && <ClaudeConnection model={settings.sidebarAgentModel} onModelChange={updateProviderModel} />}

        {provider === "ollama" && (
          <>
            <TextInput
              label="Ollama Base URL"
              description="Ollama Cloud OpenAI-compatible endpoint"
              type="url"
              value={settings.ollamaBaseUrl}
              onChange={(value) => {
                updateSetting("ollamaBaseUrl", value);
                updateSetting("modelProviders", {
                  ...settings.modelProviders,
                  ollama: { ...settings.modelProviders.ollama, baseUrl: value },
                });
              }}
              placeholder={DEFAULT_OLLAMA_BASE_URL}
              hasSpellCheck={false}
            />
            <ProviderModelPicker
              label="Sidebar Agent Model"
              description="Ollama Cloud에서 사용 가능한 모델 목록을 불러옵니다"
              models={modelsForProvider}
              value={currentModel}
              placeholder="qwen3.5:397b"
              loading={loadingModels}
              error={modelListError}
              onRefresh={() => fetchProviderModels(provider, settings)}
              onChange={updateProviderModel}
            />
          </>
        )}

        {(provider === "deepseek" || provider === "openai") && (
          <>
            <TextInput
              label={`${providerLabel} API Key`}
              description="Bun main process에서만 사용됩니다"
              type="password"
              value={provider === "deepseek" ? settings.deepseekApiKey : settings.openaiApiKey}
              onChange={(value) => {
                if (provider === "deepseek") updateSetting("deepseekApiKey", value);
                if (provider === "openai") updateSetting("openaiApiKey", value);
              }}
              placeholder="Enter API key..."
              autoComplete="off"
            />
            <TextInput
              label="Base URL"
              description="OpenAI-compatible endpoint"
              type="url"
              value={provider === "deepseek" ? settings.deepseekBaseUrl : settings.openaiBaseUrl}
              onChange={(value) => {
                if (provider === "deepseek") {
                  updateSetting("deepseekBaseUrl", value);
                  updateSetting("modelProviders", {
                    ...settings.modelProviders,
                    deepseek: { ...settings.modelProviders.deepseek, baseUrl: value },
                  });
                }
                if (provider === "openai") {
                  updateSetting("openaiBaseUrl", value);
                  updateSetting("modelProviders", {
                    ...settings.modelProviders,
                    openai: { ...settings.modelProviders.openai, baseUrl: value },
                  });
                }
              }}
              hasSpellCheck={false}
            />
            <ProviderModelPicker
              label="Sidebar Agent Model"
              description="Provider API에서 모델 목록을 불러옵니다"
              models={modelsForProvider.length > 0 ? modelsForProvider : MODEL_PRESETS[provider]}
              value={currentModel}
              placeholder={MODEL_PRESETS[provider][0]}
              loading={loadingModels}
              error={modelListError}
              onRefresh={() => fetchProviderModels(provider, settings)}
              onChange={updateProviderModel}
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Keys & search">
        <TextInput
          label="Ollama API Key"
          description="Ollama Cloud 모델 조회와 생성에 사용됩니다"
          type="password"
          value={settings.ollamaApiKey}
          onChange={(value) => updateSetting("ollamaApiKey", value)}
          placeholder="ollama_..."
          autoComplete="off"
        />
        <VStack gap={1.5}>
          <TextInput
            label="TinyFish API Key"
            description="Search와 Fetch 요청에 사용되며 Bun main process에서만 전송됩니다"
            type="password"
            value={settings.tinyfishApiKey}
            onChange={(value) => updateSetting("tinyfishApiKey", value)}
            placeholder="Enter TinyFish API key..."
            autoComplete="off"
          />
          <ExternalLink href="https://agent.tinyfish.ai/api-keys">TinyFish API key 만들기</ExternalLink>
        </VStack>
        <Switch
          label="Automatic Web Search"
          description="OpenAlex semantic search와 PubMed를 결합하고 TinyFish로 일반 웹을 보완합니다"
          value={settings.webSearchEnabled}
          onChange={(checked) => updateSetting("webSearchEnabled", checked)}
          labelPosition="start"
          labelSpacing="spread"
          width="100%"
        />
        <SettingsNote>
          PubMed 검색은 NCBI E-utilities를 사용합니다. 초록과 메타데이터의 이용 조건은{" "}
          <ExternalLink href="https://www.ncbi.nlm.nih.gov/home/about/policies/">NCBI policies</ExternalLink>
          를 따릅니다.
        </SettingsNote>
      </SettingsSection>
    </>
  );

  const citationsPane = (
    <SettingsSection title="Literature services" description="문헌 검색과 인용 근거 찾기에 쓰는 외부 서비스 키입니다.">
      <VStack gap={1.5}>
        <TextInput
          label="Paperclip API Key"
          description="Find Citation에서 선택문을 AI가 영어 주장으로 정리한 뒤, 지지·반박 근거를 검색합니다. 키가 없거나 검색에 실패하면 기존 문헌 검색을 사용합니다."
          type="password"
          value={settings.paperclipApiKey ?? ""}
          onChange={(value) => updateSetting("paperclipApiKey", value)}
          placeholder="Enter Paperclip API key…"
          autoComplete="off"
          hasSpellCheck={false}
        />
        <ExternalLink href="https://paperclip.gxl.ai/keys">Paperclip API key 만들기</ExternalLink>
        <SettingsNote>정리된 주장만 Paperclip에 전송합니다. 공개 결과 링크는 생성하지 않습니다.</SettingsNote>
      </VStack>
      <VStack gap={1.5}>
        <TextInput
          label="OpenAlex API Key"
          description="Semantic literature search와 citation discovery에 사용됩니다"
          type="password"
          value={settings.openAlexApiKey}
          onChange={(value) => updateSetting("openAlexApiKey", value)}
          placeholder="Enter OpenAlex API key…"
          autoComplete="off"
        />
        <ExternalLink href="https://openalex.org/settings/api">OpenAlex API key 만들기</ExternalLink>
      </VStack>
      <VStack gap={1.5}>
        <TextInput
          label="NCBI API Key"
          description="PubMed ESearch와 EFetch의 요청 한도와 안정성을 높입니다"
          type="password"
          value={settings.ncbiApiKey}
          onChange={(value) => updateSetting("ncbiApiKey", value)}
          placeholder="Enter NCBI API key…"
          autoComplete="off"
        />
        <ExternalLink href="https://account.ncbi.nlm.nih.gov/settings/">NCBI API key 만들기</ExternalLink>
      </VStack>
    </SettingsSection>
  );

  const paneContent: Record<SettingsPane, React.ReactNode> = {
    general: generalPane,
    ai: aiPane,
    citations: citationsPane,
    // Writing and extension settings save immediately; the footer's Save
    // button applies only to the app settings in the other panes.
    writing: <WritingPreferencesPanel />,
    extensions: <><ExtensionSettings /><ExtensionSlot name="settings" /></>,
  };
  const activePane = PANES.find((p) => p.id === pane)!;
  const savesImmediately = pane === "writing" || pane === "extensions";

  return (
    <div className="settings-page flex flex-1 flex-col overflow-hidden bg-background">
      <Layout
        height="fill"
        header={
          <LayoutHeader hasDivider padding={2}>
            <HStack gap={2} vAlign="center">
              <Button label="Back to editor" variant="ghost" size="sm" isIconOnly tooltip="Back to editor"
                icon={<ArrowLeft className="h-4 w-4" aria-hidden="true" />} onClick={onClose} />
              <Heading level={2}>Settings</Heading>
            </HStack>
          </LayoutHeader>
        }
        start={
          <LayoutPanel hasDivider padding={2} width={220} label="Settings sections">
            <List density="compact">
              {PANES.map((item) => (
                <ListItem
                  key={item.id}
                  label={item.label}
                  startContent={<Icon icon={item.icon} size="sm" />}
                  isSelected={pane === item.id}
                  onClick={() => setPane(item.id)}
                />
              ))}
            </List>
          </LayoutPanel>
        }
        content={
          <LayoutContent padding={6} label={`${activePane.label} settings`}>
            <VStack gap={8} maxWidth={640}>
              <Heading level={2}>{activePane.label}</Heading>
              {paneContent[pane]}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider padding={3}>
            <HStack gap={2} vAlign="center" hAlign="between">
              <Text type="supporting" color={saved ? "accent" : "secondary"} display="block" as="p" role="status">
                {saved ? "Settings saved" : savesImmediately ? "이 화면의 변경은 즉시 저장됩니다." : ""}
              </Text>
              <HStack gap={2}>
                <Button label="Cancel" variant="secondary" onClick={onClose} />
                <Button label={saving ? "Saving..." : "Save Settings"} variant="primary" isLoading={saving} onClick={handleSave} />
              </HStack>
            </HStack>
          </LayoutFooter>
        }
      />
    </div>
  );
}
