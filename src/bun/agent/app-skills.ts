import { copyFile, mkdir, readdir, stat, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const SCHOLARPEN_BASE = join(homedir(), "ScholarPen");
export const APP_SKILLS_DIR = join(SCHOLARPEN_BASE, "skills");
export const APP_COMMANDS_DIR = join(SCHOLARPEN_BASE, "commands");
const CLAUDE_COMMANDS_DIR = join(homedir(), ".claude", "commands");

const DEFAULT_APP_SKILLS: Array<{ name: string; content: string }> = [
  {
    name: "academic-review",
    content: `# Academic Review

description: Review a manuscript passage for argument quality, evidence use, and academic clarity.

You are reviewing academic writing inside ScholarPen.

- Identify the central claim before suggesting edits.
- Point out missing evidence, weak transitions, overclaims, and unclear scope.
- Preserve the author's intended argument and disciplinary nuance.
- If KB or @file context is present, ground feedback in that material.
- Do not claim to have inspected files that were not provided.
- Return concise, actionable feedback with prioritized revisions.
`,
  },
  {
    name: "rewrite-section",
    content: `# Rewrite Section

description: Rewrite selected academic text while preserving meaning, citations, and tone.

Rewrite for academic clarity.

- Preserve all citation markers, DOI strings, equations, and technical terms.
- Do not add new claims unless explicitly requested.
- Prefer direct, readable sentences over ornate prose.
- If the user asks for alternatives, provide 2-3 distinct versions.
- Briefly note what changed after the rewrite.
`,
  },
  {
    name: "summarize-kb",
    content: `# Summarize KB

description: Synthesize provided Knowledge Base context into a compact research summary.

Use only supplied KB context and @files.

- Start with the key takeaway.
- Group related findings instead of listing every snippet.
- Mark uncertainty and contradictions clearly.
- Include source references when KB references are provided.
- End with concrete follow-up questions or next reading targets when useful.
`,
  },
  {
    name: "citation-check",
    content: `# Citation Check

description: Check whether claims are supported by the provided citations or KB context.

Evaluate citation support conservatively.

- Separate supported, weakly supported, and unsupported claims.
- Do not invent bibliographic metadata.
- If DOI or citation metadata is absent, say what information is missing.
- Suggest where a citation is needed when a sentence makes an empirical or theoretical claim.
`,
  },
  {
    name: "research-gap",
    content: `# Research Gap

description: Identify research gaps from supplied notes, KB context, or manuscript text.

Find gaps that can support an academic contribution.

- Distinguish empirical gaps, theoretical gaps, methodological gaps, and scope gaps.
- Avoid generic gap statements.
- Tie each gap to the provided material.
- Suggest a precise research question or contribution statement.
`,
  },
  {
    name: "outline-paper",
    content: `# Outline Paper

description: Build or refine a paper outline from the current research context.

Create a focused academic article structure.

- Infer the likely thesis and audience from supplied context.
- Use standard sections only when they fit the project.
- For each section, state its job in the argument.
- Flag missing evidence or unresolved decisions.
- Keep the outline practical enough to write from immediately.
`,
  },
];

const DEFAULT_APP_COMMANDS: Array<{ filename: string; content: string }> = [
  {
    filename: "kb-query.md",
    content: `<!-- ScholarPen command: kb-query -->
Answer "$ARGUMENTS" using the local Knowledge Base wiki.

Do NOT use subagents. Do NOT call external APIs. This command works from local KB files supplied by ScholarPen.

---

## Argument Format

\`$ARGUMENTS\` may be either:

- **Question only:** \`what is X?\` -> use the current project's Knowledge Base.
- **Path + question:** \`/path/to/knowledge-base what is X?\` -> use the given path as KB root.

ScholarPen normally provides KB search context automatically. If <kb_context> is present, use that first.

---

## Response Structure

### Direct Answer
Answer the question in manuscript-ready academic prose.

### Key Evidence
List the specific KB sources, concepts, or notes that support the answer. Every substantive claim should trace to a supplied KB reference or @file.

### Tensions and Gaps
Name contradictions, weak evidence, or missing sources. If the KB does not contain enough evidence, say so explicitly.

### Writing Suggestions
Suggest how this material can be used in the paper:

- citation candidates
- framing angle
- quote candidates when useful
- follow-up KB or literature work

### Coverage
Report whether coverage is high, partial, or low based only on the provided KB context.

---

## Rules

- Never fabricate. If something is not in the provided KB context or @files, say it is not available.
- Do not claim to have read files that ScholarPen did not provide.
- Prefer KB references over general model knowledge.
- If web search is enabled, clearly separate web results from KB evidence and cite web results as [W1], [W2], etc.
- Keep the answer useful for academic writing.
`,
  },
];

export async function seedAppSkills(): Promise<void> {
  await mkdir(APP_SKILLS_DIR, { recursive: true });
  await Promise.all(DEFAULT_APP_SKILLS.map(async (skill) => {
    const dir = join(APP_SKILLS_DIR, skill.name);
    const file = join(dir, "SKILL.md");
    await mkdir(dir, { recursive: true });
    try {
      await stat(file);
    } catch {
      await writeFile(file, skill.content, "utf-8");
    }
  }));
}

export async function seedAppCommands(): Promise<void> {
  await mkdir(APP_COMMANDS_DIR, { recursive: true });
  await Promise.all(DEFAULT_APP_COMMANDS.map(async (command) => {
    const file = join(APP_COMMANDS_DIR, command.filename);
    try {
      await stat(file);
    } catch {
      await writeFile(file, command.content, "utf-8");
    }
  }));

  let entries: Array<{ isFile: () => boolean; name: string }>;
  try {
    entries = await readdir(CLAUDE_COMMANDS_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map(async (entry) => {
      const source = join(CLAUDE_COMMANDS_DIR, entry.name);
      const target = join(APP_COMMANDS_DIR, entry.name);
      try {
        await stat(target);
      } catch {
        await copyFile(source, target);
      }
    }));
}

export async function seedAppInstructions(): Promise<void> {
  await seedAppSkills();
  await seedAppCommands();
}
