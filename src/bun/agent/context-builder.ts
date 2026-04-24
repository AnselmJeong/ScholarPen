import type { AgentMessage, AgentStreamParams, AppSettings, OllamaMessage } from "../../shared/rpc-types";
import { findKBRoot, getKBEngine, type KBSearchResult } from "../kb/search";
import { buildReferenceList } from "./references";
import { loadAgentSkill } from "./skill-registry";
import { resolveMentionedFiles } from "./mention-resolver";

const HISTORY_MESSAGE_LIMIT = 4_000;
const HISTORY_TOTAL_LIMIT = 16_000;
const SYSTEM_CONTEXT_LIMIT = 90_000;
const USER_MESSAGE_LIMIT = 30_000;

function languageRule(lang: "ko" | "en"): string {
  return lang === "ko"
    ? "답변은 반드시 한국어로 작성한다. 필요한 전문 용어는 영어 병기를 허용한다."
    : "Respond in English only.";
}

function trimMiddle(content: string, limit: number, marker = "[...truncated...]"): string {
  const normalized = content.trim();
  if (normalized.length <= limit) return normalized;
  const head = normalized.slice(0, Math.floor(limit * 0.7));
  const tail = normalized.slice(-Math.floor(limit * 0.2));
  return `${head}\n\n${marker}\n\n${tail}`;
}

function historyToMessages(history: AgentMessage[]): OllamaMessage[] {
  let total = 0;
  const compacted: OllamaMessage[] = [];

  for (const message of history.slice(-8).reverse()) {
    const content = trimMiddle(message.content, HISTORY_MESSAGE_LIMIT, "[...previous message truncated...]");
    if (!content) continue;
    if (message.role === "assistant" && content.startsWith("❌")) continue;
    if (total + content.length > HISTORY_TOTAL_LIMIT) break;
    compacted.unshift({ role: message.role, content });
    total += content.length;
  }

  return compacted;
}

function kbContext(results: KBSearchResult[]): string {
  if (results.length === 0) return "";
  const items = results.map((r, index) => {
    const excerpt = r.excerpt.replace(/\n+/g, " ").trim().slice(0, 700);
    return `[${index + 1}] ${r.title || r.docId} (${r.docType})\n${excerpt}`;
  });
  return `<kb_context>\n${items.join("\n\n")}\n</kb_context>`;
}

export async function buildAgentMessages(
  params: AgentStreamParams,
  settings: AppSettings,
): Promise<{ messages: OllamaMessage[]; references: string }> {
  const selectedSkills = await Promise.all(
    params.selectedSkillIds.map((id) => loadAgentSkill(id, params.projectPath ?? undefined))
  );

  const mentionedFiles = params.projectPath
    ? await resolveMentionedFiles({
        message: params.message,
        explicitFilePaths: params.selectedFilePaths,
        projectPath: params.projectPath,
      })
    : [];

  let kbResults: KBSearchResult[] = [];
  if (params.kbEnabled && params.projectPath) {
    const kbRoot = await findKBRoot(params.projectPath);
    if (kbRoot) {
      const engine = getKBEngine(kbRoot);
      await engine.ensureIndexed();
      kbResults = engine.search(params.message, settings.kbTopK || 5);
    }
  }

  const systemParts = [
    "<scholarpen_system>",
    "You are ScholarPen's research writing assistant.",
    "Use only the project files, selected skills, and KB references that are explicitly provided in this request.",
    "Do not claim to have read files that were not provided.",
    params.kbEnabled
      ? "KB search is ON. Use KB references only when <kb_context> is present."
      : "KB search is OFF. No Knowledge_Base content is provided in this request.",
    mentionedFiles.length > 0
      ? "The user designated project files for this request; you may discuss those provided files."
      : "No project file content is provided in this request. Do not say that you reviewed current project files.",
    "When a user designates @files, prioritize those files.",
    "When a skill is selected with /skill, follow the skill instructions within ScholarPen's safety limits.",
    "For academic writing, preserve nuance and cite provided KB references when used.",
    "You are read-only unless the user explicitly accepts a proposed write action.",
    languageRule(params.lang),
    params.projectPath ? `Current project path: ${params.projectPath}` : "No project is currently open.",
    "</scholarpen_system>",
    ...selectedSkills.map(
      (skill) =>
        `<selected_skill id="${skill.id}" name="${skill.name}" source="${skill.source}">\n${skill.content}\n</selected_skill>`
    ),
    ...mentionedFiles.map(
      (file) =>
        `<mentioned_file path="${file.displayPath}" truncated="${file.truncated ? "true" : "false"}">\n${file.content}\n</mentioned_file>`
    ),
    kbContext(kbResults),
  ].filter(Boolean);

  const references = kbResults.length > 0 ? buildReferenceList(kbResults) : "";
  const systemContent = trimMiddle(
    systemParts.join("\n\n"),
    SYSTEM_CONTEXT_LIMIT,
    "[...project context truncated to fit provider request limits...]",
  );

  return {
    messages: [
      { role: "system", content: systemContent },
      ...historyToMessages(params.history),
      { role: "user", content: trimMiddle(params.message, USER_MESSAGE_LIMIT, "[...user message truncated...]") },
    ],
    references,
  };
}
