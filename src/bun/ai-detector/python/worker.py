"""Offline DetectorScope adapter. Filter inference copies, preserve source snapshots."""
import contextlib
import json
import math
from pathlib import Path
import sys

CONFIG = json.loads(Path(__file__).with_name("detector_config.json").read_text())
MAX_CHARACTERS = 100_000
MAX_TOKENS = 32_000
MIN_TOKENS = 64
WINDOW = 1024  # DetectorScope 0.0.1's extractor truncates here, including BOS.


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def inference_text(text):
    """Replace outer square-bracket ranges with one separator, mapping to source.

    Nested/multiline brackets are excluded too. An unclosed '[' excludes the
    remainder. A separator prevents surrounding words from being concatenated;
    its False flag means it can never become highlighted source evidence.
    """
    chars, mapping = [], []
    index = 0
    while index < len(text):
        start = index
        if text[index] == "[":
            depth = 1
            index += 1
            while index < len(text) and depth:
                if text[index] == "[":
                    depth += 1
                elif text[index] == "]":
                    depth -= 1
                index += 1
            chars.append(" ")
            mapping.append((start, index, False))
        else:
            chars.append(text[index])
            index += 1
            mapping.append((start, index, True))
    filtered = "".join(chars)
    if not filtered.strip():
        raise ValueError("텍스트에서 대괄호 내용을 제외하면 분석할 본문이 없습니다.")
    return filtered, mapping


def text_windows(text, tokenizer):
    """Partition original characters, then re-tokenize each slice to prevent truncation.

    Token offsets can overlap for multibyte characters. Never decode/split token
    ids: that can corrupt Korean/emoji or silently normalize the source.
    """
    all_ids = tokenizer.encode(text, add_special_tokens=False, truncation=False)
    if len(all_ids) < MIN_TOKENS:
        raise ValueError("텍스트가 너무 짧습니다. 최소 64토큰 이상의 문단을 선택해 주세요.")
    if len(all_ids) > MAX_TOKENS:
        raise ValueError("32,000토큰을 초과했습니다. 더 짧은 범위를 선택해 주세요.")
    start = 0
    while start < len(text):
        remaining = text[start:]
        encoded = tokenizer(remaining, truncation=False, return_offsets_mapping=True)
        end = len(text)
        if len(encoded["input_ids"]) > WINDOW:
            # Reserve space for boundary re-tokenization and special tokens.
            offsets = encoded["offset_mapping"][:WINDOW - 16]
            end = start + max(b for a, b in offsets)
        while end > start and len(tokenizer.encode(text[start:end], truncation=False)) > WINDOW:
            end -= 1
        if end <= start:
            raise ValueError("텍스트를 안전한 분석 구간으로 나누지 못했습니다.")
        yield start, end, text[start:end]
        start = end


def feature_spans(feature, offsets, text, mapping=None, source_start=0):
    """Keep up to three strongest activation locations, with exact UTF-16 offsets."""
    ranked = sorted(feature.highlights or [], key=lambda pair: -pair[1])
    spans = []
    for index, activation in ranked:
        if not 0 <= index < len(offsets) or not math.isfinite(activation) or activation <= 0:
            continue
        start, end = offsets[index]
        if start == end:
            continue  # BOS/padding has no corresponding source text.
        runs = []
        if mapping is None:
            runs = [(start, end)]
        else:
            for left, right, included in mapping[start:end]:
                if not included:
                    continue
                left, right = left - source_start, right - source_start
                if runs and runs[-1][1] == left:
                    runs[-1] = (runs[-1][0], right)
                else:
                    runs.append((left, right))
        for left, right in runs:
            a, b = utf16_length(text[:left]), utf16_length(text[:right])
            if not text[left:right].strip() or any(a < s["end"] and b > s["start"] for s in spans):
                continue
            spans.append({"start": a, "end": b, "activation": float(activation)})
            if len(spans) == 3:
                break
        if len(spans) == 3:
            break
    return sorted(spans, key=lambda span: span["start"])


def analyze_with_detector(text, detector):
    filtered, mapping = inference_text(text)
    tokenizer = detector.extractor.tokenizer
    threshold = float(detector.load_head().threshold)
    windows = []
    for start, end, passage in text_windows(filtered, tokenizer):
        source_start, source_end = mapping[start][0], mapping[end - 1][1]
        source = text[source_start:source_end]
        output = detector(passage, return_highlights=True)
        encoding = tokenizer(passage, truncation=False, return_offsets_mapping=True)
        offsets = encoding["offset_mapping"]
        # Check alignment against the exact tokenizer used by the model.
        if output.tokens != [passage[a:b] for a, b in offsets] or len(offsets) > WINDOW:
            raise ValueError("모델의 토큰 위치와 원문이 일치하지 않습니다.")
        features = sorted(output.features, key=lambda f: -abs(f.importance))
        selected = ([f for f in features if f.importance > 0][:3] +
                    [f for f in features if f.importance < 0][:2])
        windows.append({
            "start": utf16_length(text[:source_start]), "end": utf16_length(text[:source_end]),
            "text": source,
            "tokens": sum(a < b for a, b in offsets),
            "pAi": float(output.p_ai), "label": output.label,
            "logit": float(output.logit), "bias": float(output.bias),
            "otherContribution": sum(float(f.importance) for f in features if f not in selected),
            "featureCount": len(features),
            "features": [{"id": f.id, "description": f.description or "설명이 없는 특징",
                          "importance": float(f.importance),
                          "spans": feature_spans(f, offsets, source, mapping[start:end], source_start)} for f in selected],
        })
    return {
        "version": 2, "engine": "detectorscope", "model": CONFIG["model"],
        "revision": CONFIG["revision"], "packageVersion": CONFIG["packageVersion"],
        "head": CONFIG["head"], "tau": CONFIG["tau"], "thresholdLogit": threshold,
        "tokens": sum(w["tokens"] for w in windows), "windows": windows,
    }


def analyze(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("분석할 텍스트가 없습니다.")
    if utf16_length(text) > MAX_CHARACTERS:
        raise ValueError("100,000자 이하의 텍스트를 선택해 분석해 주세요.")
    filtered, _ = inference_text(text)
    from importlib.metadata import version
    if version("detectorscope") != CONFIG["packageVersion"]:
        raise ValueError("DetectorScope 버전이 다릅니다. Settings 또는 분석 패널에서 DetectorScope를 설치·복구해 주세요.")
    from detectorscope import AuditableDetector
    from huggingface_hub import hf_hub_download
    from transformers import AutoTokenizer
    tokenizer_config = hf_hub_download(
        CONFIG["model"], "extractor/tokenizer_config.json",
        revision=CONFIG["revision"], local_files_only=True,
    )
    tokenizer = AutoTokenizer.from_pretrained(str(Path(tokenizer_config).parent), local_files_only=True)
    # Reject short/oversized token inputs before allocating the large model.
    list(text_windows(filtered, tokenizer))
    import torch
    # Upstream supports CPU/CUDA. Do not silently alter its inference for MPS.
    torch.set_num_threads(min(8, torch.get_num_threads()))
    detector = AuditableDetector.from_pretrained(
        CONFIG["model"], revision=CONFIG["revision"], local_files_only=True,
        head=CONFIG["head"], tau=CONFIG["tau"], torch_dtype="float32",
    )
    detector.eval()
    detector.extractor.model.eval()
    with torch.inference_mode():
        return analyze_with_detector(text, detector)


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read(MAX_CHARACTERS * 12 + 1024))
        # Third-party progress/diagnostics must not corrupt the JSON protocol.
        with contextlib.redirect_stdout(sys.stderr):
            report = analyze(request["text"])
        print(json.dumps({"ok": True, "report": report}, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        if isinstance(error, ValueError) and str(error).startswith(("텍스트", "100,000", "32,000", "분석할", "모델의", "DetectorScope")):
            message = str(error)
        elif isinstance(error, (ImportError, OSError)):
            message = "DetectorScope 실행 환경 또는 모델이 없습니다. Settings 또는 분석 패널에서 DetectorScope를 설치·복구해 주세요."
        else:
            message = f"DetectorScope 분석에 실패했습니다 ({type(error).__name__})."
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        sys.exit(1)
