"""1단계(텍스트): 숨은 문자 / 기계적 지문 검사.

AI 출력이나 복사·붙여넣기 과정에서 섞여 들어오는 '보이지 않는' 유니코드를 찾는다.
이건 통계적 워터마크가 아니라 '기계적 흔적'이라서 제거도 쉽다.
(Slop or Not의 '숨은 문자 탐지기'가 하는 일이 이것)
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass, field

# 코드포인트 -> (분류, 설명)
_KNOWN: dict[int, tuple[str, str]] = {
    0x200B: ("zero_width", "ZERO WIDTH SPACE"),
    0x200C: ("zero_width", "ZERO WIDTH NON-JOINER"),
    0x200D: ("zero_width", "ZERO WIDTH JOINER"),
    0x2060: ("zero_width", "WORD JOINER"),
    0xFEFF: ("zero_width", "BOM / ZERO WIDTH NO-BREAK SPACE"),
    0x00AD: ("zero_width", "SOFT HYPHEN"),
    0x180E: ("zero_width", "MONGOLIAN VOWEL SEPARATOR"),
    0x200E: ("bidi", "LEFT-TO-RIGHT MARK"),
    0x200F: ("bidi", "RIGHT-TO-LEFT MARK"),
    0x00A0: ("odd_space", "NO-BREAK SPACE"),
    0x202F: ("odd_space", "NARROW NO-BREAK SPACE"),
    0x2007: ("odd_space", "FIGURE SPACE"),
    0x2009: ("odd_space", "THIN SPACE"),
    0x200A: ("odd_space", "HAIR SPACE"),
    0x2002: ("odd_space", "EN SPACE"),
    0x2003: ("odd_space", "EM SPACE"),
    0x2004: ("odd_space", "THREE-PER-EM SPACE"),
    0x2005: ("odd_space", "FOUR-PER-EM SPACE"),
    0x2006: ("odd_space", "SIX-PER-EM SPACE"),
    0x2008: ("odd_space", "PUNCTUATION SPACE"),
    0x205F: ("odd_space", "MEDIUM MATHEMATICAL SPACE"),
}
for _cp in (*range(0x202A, 0x202F), *range(0x2066, 0x206A)):
    _KNOWN[_cp] = ("bidi", unicodedata.name(chr(_cp), f"U+{_cp:04X}"))

# 스마트 문장부호: 증거가 아니라 '참고'용. 워드프로세서도 자동으로 만든다.
_SMART_PUNCT = {
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "—": "-", "–": "-", "…": "...",
}

# 라틴 문자와 똑같이 생긴 키릴/그리스 문자 (호모글리프)
_HOMOGLYPHS = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i",
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P",
    "С": "C", "Т": "T", "Х": "X", "ο": "o", "Ο": "O", "α": "a", "Α": "A", "Β": "B",
    "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ρ": "P",
    "Τ": "T", "Υ": "Y", "Χ": "X",
}


@dataclass
class Finding:
    index: int
    char: str
    codepoint: str
    category: str
    name: str


@dataclass
class HiddenCharReport:
    findings: list[Finding] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    smuggled_ascii: str = ""  # Unicode TAG 문자로 숨겨진 메시지

    @property
    def suspicious(self) -> bool:
        strong = {"zero_width", "bidi", "tag", "variation_selector", "homoglyph", "other_format"}
        return any(self.counts.get(c, 0) for c in strong)


def _classify(text: str, i: int) -> tuple[str, str] | None:
    ch = text[i]
    cp = ord(ch)
    if cp in _KNOWN:
        return _KNOWN[cp]
    if 0xE0000 <= cp <= 0xE007F:
        return "tag", "TAG CHARACTER (ASCII smuggling)"
    if 0xFE00 <= cp <= 0xFE0F or 0xE0100 <= cp <= 0xE01EF:
        # 이모지 바로 뒤의 VS16은 정상이다
        prev = text[i - 1] if i else ""
        if cp == 0xFE0F and prev and unicodedata.category(prev) == "So":
            return None
        return "variation_selector", "VARIATION SELECTOR (데이터 은닉 가능)"
    if ch in _SMART_PUNCT:
        return "smart_punct", unicodedata.name(ch)
    if ch in _HOMOGLYPHS:
        # 주변이 라틴 문자일 때만 호모글리프로 본다 (러시아어 본문 오탐 방지)
        neighbors = text[max(0, i - 1):i] + text[i + 1:i + 2]
        if any("LATIN" in unicodedata.name(n, "") for n in neighbors):
            return "homoglyph", f"{unicodedata.name(ch)} (looks like '{_HOMOGLYPHS[ch]}')"
        return None
    if unicodedata.category(ch) == "Cf":
        return "other_format", unicodedata.name(ch, f"U+{cp:04X}")
    return None


def scan(text: str) -> HiddenCharReport:
    report = HiddenCharReport()
    smuggled = []
    for i, ch in enumerate(text):
        hit = _classify(text, i)
        if hit is None:
            continue
        cat, name = hit
        report.findings.append(Finding(i, ch, f"U+{ord(ch):04X}", cat, name))
        report.counts[cat] = report.counts.get(cat, 0) + 1
        if cat == "tag" and 0xE0020 <= ord(ch) <= 0xE007E:
            smuggled.append(chr(ord(ch) - 0xE0000))
    report.smuggled_ascii = "".join(smuggled)
    return report


def clean(text: str, normalize_punct: bool = False) -> str:
    """기계적 흔적만 제거한다. 단어는 하나도 바꾸지 않는다."""
    out = []
    for i, ch in enumerate(text):
        hit = _classify(text, i)
        if hit is None:
            out.append(ch)
            continue
        cat = hit[0]
        if cat == "odd_space":
            out.append(" ")
        elif cat == "homoglyph":
            out.append(_HOMOGLYPHS[ch])
        elif cat == "smart_punct":
            out.append(_SMART_PUNCT[ch] if normalize_punct else ch)
        # zero_width / bidi / tag / variation_selector / other_format 는 삭제
    return "".join(out)
