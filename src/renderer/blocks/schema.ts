import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { mathBlock } from "./math-block";
import { figureBlock } from "./figure-block";
import { abstractBlock } from "./abstract-block";
import { citationInline, footnoteInline } from "./citation-inline";

// ── Scholar BlockNote Schema ────────────────────────────────────────────────
// Extends the default schema with scholar-specific block and inline types.

export const scholarSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    math: mathBlock(),
    figure: figureBlock(),
    abstract: abstractBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    citation: citationInline,
    footnote: footnoteInline,
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
