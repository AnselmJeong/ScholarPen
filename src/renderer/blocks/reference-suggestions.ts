import type { BlockNoteEditor } from "@blocknote/core";
import { collectReferenceTargets, isQuartoReference } from "../../shared/quarto-references";
import type { ProjectReferenceTarget } from "../../shared/project-references";

export function referenceSuggestions(editor: BlockNoteEditor<any, any, any>, citekeys: string[], query: string,
  project?: { targets: ProjectReferenceTarget[]; errors: string[] }) {
  const search = query.toLowerCase();
  const targets = project?.targets ?? collectReferenceTargets(editor.document).map((target) => ({ ...target, filename: "" }));
  const counts = new Map<string, number>();
  for (const target of targets) counts.set(target.label, (counts.get(target.label) ?? 0) + 1);
  const references = targets.filter((target) =>
    `${target.label} ${target.title} ${target.filename}`.toLowerCase().includes(search));
  return [
    ...references.map((target) => ({
      title: target.label, group: project ? "Project references" : "Document references",
      subtext: [target.filename, target.title, counts.get(target.label)! > 1 ? "Duplicate identifier" : ""].filter(Boolean).join(" · "),
      // Brackets keep a Korean particle or adjacent text from becoming part of
      // the target key when the structured reference is exported to QMD.
      onItemClick: () => editor.insertInlineContent([{ type: "crossReference", props: { label: target.label, locator: "", bracketed: true } }]),
    })),
    ...citekeys.filter((key) => !isQuartoReference(key) && key.toLowerCase().includes(search)).map((key) => ({
      title: key, group: "Citations", subtext: "Insert inline citation",
      onItemClick: () => editor.insertInlineContent([{ type: "citation", props: { citekey: key, locator: "" } }]),
    })),
    ...(project?.errors.length ? [{
      title: "Some project references could not be loaded", group: "Reference status",
      subtext: project.errors.join(", "), onItemClick: () => {},
    }] : []),
  ];
}
