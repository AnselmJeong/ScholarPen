export type ManuscriptLanguage = "korean" | "english" | "undetermined";

/** Count words so long English technical terms do not outweigh Korean prose. */
export function dominantLanguage(text: string): ManuscriptLanguage {
  let korean = 0, english = 0, other = 0;
  for (const word of text.normalize("NFC").match(/[\p{L}\p{M}]+/gu) ?? []) {
    if (/\p{Script=Hangul}/u.test(word)) korean++;
    else if (/^\p{Script=Latin}[\p{Script=Latin}\p{M}]*$/u.test(word)) english++;
    else other++;
  }
  const total = korean + english + other;
  if (korean > total / 2) return "korean";
  if (english > total / 2) return "english";
  return "undetermined";
}
