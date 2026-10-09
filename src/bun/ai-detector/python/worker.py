"""ScholarPen JSON/stdin adapter for the local Watermark_Detector prototype.

No classification threshold or uncalibrated probability is exported.
All token transitions are scored using overlapping context windows.
"""
import json
import math
import sys

MAX_CHARACTERS = 100_000
MAX_TOKENS = 32_000
MIN_TOKENS = 64
WINDOW = 256


def token_windows(ids, size=WINDOW):
    if size < 2:
        raise ValueError("Window must hold at least two tokens")
    # Reuse the last token as the next window's first context token.
    for start in range(0, len(ids) - 1, size - 1):
        yield ids[start:start + size]


def analyze(text):
    if not isinstance(text, str) or not text.strip():
        raise ValueError("분석할 텍스트가 없습니다.")
    if len(text) > MAX_CHARACTERS:
        raise ValueError("100,000자 이하의 텍스트를 선택해 분석해 주세요.")
    from detector.text_hidden_chars import scan, clean
    report = scan(text)
    cleaned = clean(text)
    from detector.text_ai_score import AITextScorer, DEFAULT_OBSERVER, DEFAULT_PERFORMER
    from transformers import AutoTokenizer
    # Check length before allocating both models. Offline enforced by the caller.
    tokenizer = AutoTokenizer.from_pretrained(DEFAULT_OBSERVER)
    ids = tokenizer.encode(cleaned, add_special_tokens=False)
    if len(ids) < MIN_TOKENS:
        raise ValueError("텍스트가 너무 짧습니다. 최소 64토큰 이상의 문단을 선택해 주세요.")
    if len(ids) > MAX_TOKENS:
        raise ValueError("32,000토큰을 초과했습니다. 더 짧은 범위를 선택해 주세요.")
    scorer = AITextScorer(max_tokens=WINDOW)
    performer_tokenizer = AutoTokenizer.from_pretrained(DEFAULT_PERFORMER)
    if scorer.tok.get_vocab() != performer_tokenizer.get_vocab():
        raise ValueError("탐지 모델의 토크나이저가 일치하지 않습니다.")
    import torch
    import torch.nn.functional as F
    total_nll = total_cross = total_observer = 0.0
    tokens = 0
    scores = []
    with torch.inference_mode():
        for window in token_windows(ids):
            inputs = torch.tensor([window], device=scorer.device)
            obs = scorer.observer(inputs, use_cache=False).logits[:, :-1].float()
            perf = scorer.performer(inputs, use_cache=False).logits[:, :-1].float()
            targets = inputs[:, 1:]
            n = targets.numel()
            nll = F.cross_entropy(perf.transpose(1, 2), targets, reduction="sum").item()
            cross = (F.softmax(obs, -1) * -F.log_softmax(perf, -1)).sum().item()
            obs_nll = F.cross_entropy(obs.transpose(1, 2), targets, reduction="sum").item()
            if cross <= 0 or not all(math.isfinite(x) for x in (nll, cross, obs_nll)):
                raise ValueError("모델이 유효한 점수를 계산하지 못했습니다.")
            total_nll += nll
            total_cross += cross
            total_observer += obs_nll
            tokens += n
            scores.append(nll / cross)
            del inputs, obs, perf, targets
    return {
        "version": 1, "score": total_nll / total_cross,
        "perplexity": math.exp(total_observer / tokens),
        "tokens": tokens, "windows": len(scores),
        "minScore": min(scores), "maxScore": max(scores),
        "hiddenCharacters": sum(n for category, n in report.counts.items() if category != "smart_punct"),
        "characterCounts": report.counts,
        "observer": DEFAULT_OBSERVER, "performer": DEFAULT_PERFORMER,
    }


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read(MAX_CHARACTERS * 12 + 1024))
        print(json.dumps({"ok": True, "report": analyze(request["text"])}, ensure_ascii=False, allow_nan=False))
    except Exception as error:
        # Do not echo text, file paths or model diagnostics back to the renderer.
        if isinstance(error, ValueError):
            message = str(error)
        elif isinstance(error, (ImportError, OSError)):
            message = "탐지기 실행 환경 또는 모델이 없습니다. bun run setup:ai-detector를 실행해 주세요."
        else:
            message = f"로컬 AI 탐지 계산에 실패했습니다 ({type(error).__name__})."
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        sys.exit(1)
