/**
 * The standing rules of the document the Assistant is about to edit: its edit
 * level, the project's glossary and chapters, and the sections set to
 * Observe. ScholarPen AI gets the same rules in its own prompts
 * (`CollabAgent.policyFor`); the app wires the source in `bun/index.ts`,
 * since only it holds the open documents.
 */
export type DocumentEditGuide = (projectPath: string, documentPath: string) => Promise<string | null>;

let source: DocumentEditGuide | null = null;

export function setDocumentEditGuide(guide: DocumentEditGuide | null) {
  source = guide;
}

/** The rules for one open document, or null when it is not open (or there is no source). */
export async function documentEditGuide(projectPath: string, documentPath: string): Promise<string | null> {
  if (!source) return null;
  try {
    return await source(projectPath, documentPath);
  } catch (error) {
    console.warn("[Agent] Could not read the document's edit rules:", error);
    return null;
  }
}
