import { PROSE_PROTECTION, PUNCTUATION_PLACEHOLDER } from "./writing-preferences";
/** Core protection remains unconditional. The host resolves explicit punctuation preferences per request. */
export const AI_WRITING_STYLE = PROSE_PROTECTION + "\n" + PUNCTUATION_PLACEHOLDER;
