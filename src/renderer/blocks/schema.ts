import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { mathBlock } from "./math-block";
import { figureBlock } from "./figure-block";
import { abstractBlock } from "./abstract-block";
import { noteBlock } from "./note-block";
import { citationInline, footnoteInline } from "./citation-inline";
import { inlineMath } from "./inline-math";
import { crossReferenceInline, quartoLiteralInline } from "./cross-reference-inline";
import { quartoHeading, quartoTable } from "./quarto-block-specs";

// ── Scholar BlockNote Schema ────────────────────────────────────────────────
// Extends the default schema with scholar-specific block and inline types.

export const scholarSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    heading: quartoHeading,
    table: quartoTable,
    math: mathBlock(),
    figure: figureBlock(),
    abstract: abstractBlock(),
    note: noteBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    citation: citationInline,
    footnote: footnoteInline,
    inlineMath: inlineMath,
    crossReference: crossReferenceInline,
    quartoLiteral: quartoLiteralInline,
  },
});

export type ScholarSchema = typeof scholarSchema;
export type ScholarEditor = typeof scholarSchema extends BlockNoteSchema<
  infer B,
  infer I,
  infer S
>
  ? import("@blocknote/core").BlockNoteEditor<B, I, S>
  : never;
