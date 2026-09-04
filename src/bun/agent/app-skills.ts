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
- If web or @file context is present, ground feedback in that material.
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
    name: "pubmed-research",
    content: `# Scholarly Literature Research

description: Combine semantic scholarly discovery with PubMed evidence for the current research question.

Use ScholarPen's OpenAlex semantic and PubMed search context as the primary evidence source.

- Translate the research question into precise biomedical concepts, populations, exposures, interventions, outcomes, and study designs.
- Prefer systematic reviews, meta-analyses, randomized trials, cohort studies, and authoritative recent reviews when appropriate.
- Distinguish evidence type, population, methods, and limitations instead of treating all papers as equally strong.
- Cite only provided sources as [W1], [W2], etc.; never invent a PMID, DOI, title, author, or result.
- Treat PubMed metadata as authoritative for PMID-linked results and distinguish OpenAlex-only records.
- When scholarly coverage is sparse, clearly label any general-web evidence used to fill the gap.
- End with unanswered questions or useful next PubMed queries when the evidence is incomplete.
`,
  },
  {
    name: "citation-check",
    content: `# Citation Check

description: Check whether claims are supported by the provided citations or live research context.

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

description: Identify research gaps from supplied notes, live sources, or manuscript text.

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
