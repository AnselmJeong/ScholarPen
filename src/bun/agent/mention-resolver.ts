import { extname, relative } from "path";
import type { AgentMentionableFile, FileNode } from "../../shared/rpc-types";
import { parseFileMentions, type ParsedFileMention } from "../../shared/file-mentions";
import { fileSystem } from "../fs/manager";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".qmd",
  ".txt",
  ".bib",
  ".json",
  ".tex",
  ".yaml",
  ".yml",
  ".csv",
]);

export interface MentionedFileContext {
  token: string;
  filePath: string;
  fileName: string;
  displayPath: string;
  content: string;
  truncated: boolean;
}

interface MentionResolverDependencies {
  listMentionableFiles?: (projectPath: string) => Promise<AgentMentionableFile[]>;
  readTextFile?: (filePath: string) => Promise<string>;
}

function flatten(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.isDirectory) result.push(...flatten(node.children ?? []));
    else result.push(node);
  }
  return result;
}

function isSupportedTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || path.endsWith(".scholarpen.json");
}

function trimContent(content: string, limit = 20_000): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false };
  const head = content.slice(0, Math.floor(limit * 0.65));
  const tail = content.slice(-Math.floor(limit * 0.25));
  return {
    content: `${head}\n\n[...truncated...]\n\n${tail}`,
    truncated: true,
  };
}

export async function listAgentMentionableFiles(projectPath: string): Promise<AgentMentionableFile[]> {
  const nodes = await fileSystem.listProjectFiles(projectPath, 0, Number.POSITIVE_INFINITY);
  return buildMentionableFiles(projectPath, nodes);
}

export function buildMentionableFiles(
  projectPath: string,
  nodes: FileNode[],
): AgentMentionableFile[] {
  return flatten(nodes)
    .filter((file) => isSupportedTextFile(file.path))
    .map((file) => ({
      name: file.name,
      path: file.path,
      displayPath: relative(projectPath, file.path),
      kind: file.kind,
    }))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

export async function resolveMentionedFiles(params: {
  message: string;
  explicitFilePaths: string[];
  projectPath: string;
}, dependencies: MentionResolverDependencies = {}): Promise<MentionedFileContext[]> {
  const mentions = parseFileMentions(params.message);
  const listFiles = dependencies.listMentionableFiles ?? listAgentMentionableFiles;
  const readTextFile = dependencies.readTextFile ?? ((filePath: string) => fileSystem.readTextFile(filePath));
  const mentionable = await listFiles(params.projectPath);
  const selected = new Map<string, string>();
  const explicitPaths = new Set(params.explicitFilePaths);

  for (const filePath of params.explicitFilePaths) {
    selected.set(filePath, filePath);
  }

  for (const mention of mentions) {
    const matches = matchMention(mention, mentionable);
    if (matches.length === 1) selected.set(matches[0].path, mention.value);
    else if (matches.length > 1 && !matches.some((file) => explicitPaths.has(file.path))) {
      throw new Error(`@${mention.value} is ambiguous. Select the exact file from the dropdown.`);
    }
  }

  const contexts: MentionedFileContext[] = [];
  for (const [filePath, token] of selected) {
    const meta = mentionable.find((file) => file.path === filePath);
    if (!meta) throw new Error(`Selected file is not part of the current project: ${filePath}`);
    if (!isSupportedTextFile(filePath)) throw new Error(`Unsupported @file type: ${meta.displayPath}`);
    const raw = await readTextFile(filePath);
    const { content, truncated } = trimContent(raw);
    contexts.push({
      token,
      filePath,
      fileName: meta.name,
      displayPath: meta.displayPath,
      content,
      truncated,
    });
  }

  return contexts;
}

function matchMention(
  mention: ParsedFileMention,
  mentionable: AgentMentionableFile[],
): AgentMentionableFile[] {
  const normalized = mention.value.toLowerCase();
  const exact = mentionable.filter(
    (file) =>
      file.name.toLowerCase() === normalized ||
      file.displayPath.toLowerCase() === normalized,
  );
  if (exact.length > 0 || mention.syntax !== "legacy") return exact;
  return mentionable.filter((file) => file.name.toLowerCase().startsWith(normalized));
}
