import { expect, test } from "bun:test";
import { cleanUnicode } from "./unicode";

test("removes invisible carriers and normalizes spaces without rewriting sentences", () => {
  const result = cleanUnicode("A\u200B visible\u2060 sentence.\u00A0한국어\uFEFF 문장.");
  expect(result.text).toBe("A visible sentence. 한국어 문장.");
  expect(result.removed).toBe(3);
  expect(result.replaced).toBe(1);
  expect(cleanUnicode(result.text).edits).toHaveLength(0);
});

test("preserves emoji, complex scripts, Hangul jamo, and legitimate bidi contexts", () => {
  for (const text of ["👨‍👩‍👧 ❤️‍🔥 ⚖️", "می‌روم", "क्‍ष", "\u1100\u1160", "\u202Bעברית\u202C", "\u2067עברית\u2069", "漢\u{E0100}", "🏴\u{E0067}\u{E0062}\u{E007F}"]) {
    expect(cleanUnicode(text).text).toBe(text);
  }
  expect(cleanUnicode("a\u200Db\uFE0Fc\u1160").text).toBe("abc");
});

test("cleans Unicode tags and reserved carriers using UTF-16 offsets", () => {
  const text = "😀A\u{E0001}B\u{E0100}C\uFDD0D\uE000";
  const result = cleanUnicode(text);
  expect(result.text).toBe("😀ABCD");
  let replay = text;
  for (const edit of [...result.edits].reverse()) replay = replay.slice(0, edit.from) + edit.insert + replay.slice(edit.to);
  expect(replay).toBe(result.text);
});
