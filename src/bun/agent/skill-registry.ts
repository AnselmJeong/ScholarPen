import { readdir, readFile, stat } from "fs/promises";
import { basename, join } from "path";
import type { AgentSkill } from "../../shared/rpc-types";
import { APP_COMMANDS_DIR, APP_SKILLS_DIR, seedAppInstructions } from "./app-skills";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function scanSkillDirs(root: string, source: AgentSkill["source"]): Promise<AgentSkill[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const skills: AgentSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourcePath = join(root, entry.name, "SKILL.md");
    if (!(await exists(sourcePath))) continue;
    skills.push({
      id: `${source}:${sourcePath}`,
      name: entry.name,
      kind: "skill",
      source,
      sourcePath,
    });
  }

  return skills;
}

async function scanCommandDir(root: string, source: AgentSkill["source"]): Promise<AgentSkill[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const sourcePath = join(root, entry.name);
      return {
        id: `${source}:${sourcePath}`,
        name: basename(entry.name, ".md"),
        kind: "command" as const,
        source,
        sourcePath,
      };
    });
}

function parseDescription(content: string): string | undefined {
  const match = content.match(/^description:\s*(.+)$/im);
  if (match) return match[1].trim();
  const firstParagraph = content
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^# .+\n/, "").trim())
    .find(Boolean);
  return firstParagraph?.slice(0, 180);
}

export async function listAgentSkills(projectPath?: string): Promise<AgentSkill[]> {
  await seedAppInstructions();
  const groups = await Promise.all([
    scanSkillDirs(APP_SKILLS_DIR, "scholarpen"),
    scanCommandDir(APP_COMMANDS_DIR, "scholarpen"),
    projectPath ? scanSkillDirs(join(projectPath, ".scholarpen", "skills"), "project") : Promise.resolve([]),
    projectPath ? scanCommandDir(join(projectPath, ".scholarpen", "commands"), "project") : Promise.resolve([]),
  ]);

  const byName = new Map<string, AgentSkill>();
  const priority: Record<AgentSkill["source"], number> = {
    project: 0,
    scholarpen: 1,
  };

  for (const skill of groups.flat().sort((a, b) => priority[a.source] - priority[b.source])) {
    const key = `${skill.kind}:${skill.name}`;
    if (!byName.has(key)) byName.set(key, skill);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadAgentSkill(id: string, projectPath?: string): Promise<AgentSkill & { content: string }> {
  const skill = (await listAgentSkills(projectPath)).find((candidate) => candidate.id === id || candidate.name === id);
  if (!skill) throw new Error(`Skill not found: ${id}`);
  const raw = await readFile(skill.sourcePath, "utf-8");
  return { ...skill, description: skill.description ?? parseDescription(raw), content: raw.slice(0, 12_000) };
}
