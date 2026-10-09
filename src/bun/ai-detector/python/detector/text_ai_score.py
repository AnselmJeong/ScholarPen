"""3단계(텍스트): 워터마크가 없을 때 — 'AI가 쓴 글 같은가'를 확률로 추정.

두 가지 신호를 계산한다.

1) Perplexity / Burstiness (GPTZero가 대중화한 방식)
   - LLM이 보기에 글이 얼마나 '예측 가능한가'. AI 글은 낮은 perplexity가 나온다.
   - burstiness = 문장별 perplexity의 들쭉날쭉한 정도. 사람 글이 더 들쭉날쭉하다.
   - 약점: 교과서, 법률 문서처럼 정형화된 사람 글도 낮게 나와 오탐이 많다.

2) Binoculars (Hans et al., 2024) — 학습 없이(zero-shot) 쓰는 탐지기 중 성능이 좋은 편
   - score = log PPL(text) / cross-PPL(observer, performer)
   - "이 글이 놀라운 정도"를 "LLM이 원래 놀라는 정도"로 나눠 정규화한다.
     → 프롬프트 탓에 perplexity가 높아진 AI 글도 잡아낸다.
   - 점수가 낮을수록 AI 쪽이다. 임계값은 모델 쌍마다 다르므로 직접 보정해야 한다
     (논문의 Falcon-7B 쌍 기준 약 0.90).
   - 두 모델은 같은 토크나이저를 써야 한다 (base + instruct 쌍이 보통).

상용 서비스(GPTZero, Slop or Not 텍스트 탭 등)는 여기에 사람/AI 라벨 데이터로
학습한 분류기(RoBERTa/DeBERTa 등)를 더해 앙상블하는 경우가 많다.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

import torch
import torch.nn.functional as F
from transformers import AutoModelForCausalLM, AutoTokenizer

DEFAULT_OBSERVER = "Qwen/Qwen2.5-0.5B"            # 한국어도 어느 정도 처리
DEFAULT_PERFORMER = "Qwen/Qwen2.5-0.5B-Instruct"


def _device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@dataclass
class AIScore:
    num_tokens: int
    perplexity: float
    burstiness: float          # 문장별 log-PPL의 표준편차
    binoculars: float
    threshold: float
    likely_ai: bool


class AITextScorer:
    def __init__(self, observer: str = DEFAULT_OBSERVER, performer: str = DEFAULT_PERFORMER,
                 threshold: float = 0.90, max_tokens: int = 512):
        self.device = _device()
        self.tok = AutoTokenizer.from_pretrained(observer)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.observer = AutoModelForCausalLM.from_pretrained(observer).to(self.device).eval()
        self.performer = AutoModelForCausalLM.from_pretrained(performer).to(self.device).eval()
        self.threshold = threshold
        self.max_tokens = max_tokens

    @torch.inference_mode()
    def _logits(self, text: str):
        enc = self.tok(text, return_tensors="pt", truncation=True,
                       max_length=self.max_tokens).to(self.device)
        obs = self.observer(**enc).logits[:, :-1].float()
        perf = self.performer(**enc).logits[:, :-1].float()
        targets = enc["input_ids"][:, 1:]
        return obs, perf, targets

    def _token_nll(self, text: str) -> torch.Tensor:
        obs, _, targets = self._logits(text)
        return F.cross_entropy(obs.transpose(1, 2), targets, reduction="none")[0]

    def score(self, text: str) -> AIScore:
        obs, perf, targets = self._logits(text)
        n = targets.shape[1]
        if n < 2:
            raise ValueError("텍스트가 너무 짧습니다")

        # log PPL: performer가 실제 토큰을 얼마나 놀라워하는가
        log_ppl = F.cross_entropy(perf.transpose(1, 2), targets).item()
        # cross-PPL: observer 분포로 샘플했을 때 performer가 평균적으로 놀라는 정도
        x_ppl = (F.softmax(obs, -1) * -F.log_softmax(perf, -1)).sum(-1).mean().item()
        binoculars = log_ppl / x_ppl

        obs_log_ppl = F.cross_entropy(obs.transpose(1, 2), targets).item()
        return AIScore(
            num_tokens=n,
            perplexity=math.exp(obs_log_ppl),
            burstiness=self._burstiness(text),
            binoculars=binoculars,
            threshold=self.threshold,
            likely_ai=binoculars < self.threshold,
        )

    def _burstiness(self, text: str) -> float:
        sents = [s for s in re.split(r"(?<=[.!?。])\s+|\n+", text) if len(s.split()) >= 3]
        if len(sents) < 2:
            return float("nan")
        vals = [self._token_nll(s).mean().item() for s in sents]
        mean = sum(vals) / len(vals)
        return math.sqrt(sum((v - mean) ** 2 for v in vals) / (len(vals) - 1))


def calibrate_threshold(scores_human: list[float], scores_ai: list[float],
                        max_fpr: float = 0.01) -> float:
    """사람 글을 AI로 잘못 판정하는 비율(FPR)이 max_fpr 이하가 되는 가장 큰 임계값."""
    s = sorted(scores_human)
    k = int(math.floor(max_fpr * len(s)))
    thr = s[k] if k < len(s) else s[-1]
    tpr = sum(x < thr for x in scores_ai) / max(1, len(scores_ai))
    print(f"threshold={thr:.4f}  TPR(AI 검출률)={tpr:.1%} @ FPR<={max_fpr:.1%}")
    return thr
