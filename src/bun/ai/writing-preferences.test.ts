import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WritingPreferencesStore } from "./writing-preferences";
import { DEFAULT_PUNCTUATION, PUNCTUATION_PLACEHOLDER, applyPunctuationPolicy, punctuationGuidance } from "../../shared/writing-preferences";
import { removeDiscouragedPunctuation } from "../../shared/ai-text-protection";
import type { OllamaMessage } from "../../shared/rpc-types";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "writing-preferences-")); roots.push(root); return { root, store: new WritingPreferencesStore(root) }; }

test("missing policy preserves historical defaults, changes persist, and stale windows cannot overwrite", async () => {
  const f = await fixture(); expect((await f.store.read()).punctuation).toEqual(DEFAULT_PUNCTUATION);
  const saved = await f.store.save(0, { emDash: "allow", semicolon: "avoid" });
  expect(await new WritingPreferencesStore(f.root).read()).toEqual(saved);
  await expect(f.store.save(0, DEFAULT_PUNCTUATION)).rejects.toThrow("변경");
  expect((await f.store.read()).punctuation.emDash).toBe("allow");
});
test("invalid or corrupt settings preserve the stored bytes", async () => {
  const f = await fixture(); await f.store.save(0, DEFAULT_PUNCTUATION);
  await expect(f.store.save(1, { emDash: "unknown", semicolon: "avoid" })).rejects.toThrow();
  await writeFile(join(f.root, "writing-preferences.json"), "{broken");
  await expect(f.store.read()).rejects.toThrow(); await expect(f.store.save(1, DEFAULT_PUNCTUATION)).rejects.toThrow();
  expect(await readFile(join(f.root, "writing-preferences.json"), "utf8")).toBe("{broken");
});
test("prompt policy is injected once, a captured request policy survives later settings changes", () => {
  const messages: OllamaMessage[] = [{ role: "system", content: `${PUNCTUATION_PLACEHOLDER}\n${PUNCTUATION_PLACEHOLDER}` }, { role: "system", content: PUNCTUATION_PLACEHOLDER }, { role: "user", content: "Source — text; literal." }];
  const first = applyPunctuationPolicy(messages, { emDash: "allow", semicolon: "allow" });
  expect(JSON.stringify(first).match(/<scholarpen_punctuation emDash/g)).toHaveLength(1);
  expect(JSON.stringify(first)).not.toContain(PUNCTUATION_PLACEHOLDER);
  expect(first.at(-1)).toEqual(messages.at(-1));
  const captured = applyPunctuationPolicy([{ role: "system", content: punctuationGuidance({ emDash: "allow", semicolon: "avoid" }) }, ...messages], DEFAULT_PUNCTUATION);
  expect(JSON.stringify(captured)).toContain('emDash=\\"allow\\"');
  expect(JSON.stringify(captured).match(/<scholarpen_punctuation emDash/g)).toHaveLength(1);
  expect(applyPunctuationPolicy(first, DEFAULT_PUNCTUATION)).toBe(first);
});
test("em dash and semicolon output corrections obey separate switches", () => {
  const prose = "Results — cautiously interpreted — were promising; further work is needed.";
  expect(removeDiscouragedPunctuation(prose, { emDash: "allow", semicolon: "allow" })).toBe(prose);
  const onlyDash = removeDiscouragedPunctuation(prose, { emDash: "avoid", semicolon: "allow" });
  expect(onlyDash).not.toContain("—"); expect(onlyDash).toContain("; further");
  const onlySemi = removeDiscouragedPunctuation(prose, { emDash: "allow", semicolon: "avoid" });
  expect(onlySemi).toContain("— cautiously interpreted —"); expect(onlySemi).toContain(". Further");
});
test("policy changes never modify literal quotations, URLs, math, code, references, markers or ranges", () => {
  const protectedText = '"A — B; C" ‘D — E; F’ https://example.org/a—b;query $a;b—c$ `x;y—z` (Kim, 2019; Lee, 2020) [@kim; @lee] ⟦SP:ns:M—;⟧ 10–20 compound-word\n```js\nlet a = 1; // —\n```';
  expect(removeDiscouragedPunctuation(protectedText, DEFAULT_PUNCTUATION)).toBe(protectedText);
});
