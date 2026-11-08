import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { detectionPresentation, type DetectionPresentation, type DetectionSection } from "../../../shared/ai-detection-presentation";
import { DETECTION_WINDOW_EXPLANATION } from "../../../shared/ai-detection";

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown skipHtml disallowedElements={["img"]}>{text}</ReactMarkdown>;
}

function ScoreGauge({ section, threshold }: { section: DetectionSection; threshold: number }) {
  return <div className="py-3">
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">구간 {section.number}{section.tokens !== undefined ? ` · ${section.tokens}토큰` : ""} · 탐지 점수</span>
      <span className="tabular-nums"><strong className="text-3xl font-semibold tracking-tight">{section.score.toFixed(1)}</strong><span className="text-xs text-muted-foreground"> / 100</span></span>
    </div>
    <div role="meter" aria-label={`구간 ${section.number} 탐지 점수`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={section.score}
      aria-valuetext={`${section.score.toFixed(1)}점, 기준 ${threshold.toFixed(1)}점, ${section.flagged ? "기준 초과" : "기준 이하"}`}
      className="relative mb-1 mt-5 flex h-3 w-full rounded-sm bg-rose-200 dark:bg-rose-950">
      <div className="h-full rounded-l-sm bg-teal-200 dark:bg-teal-900" style={{ width: `${threshold}%` }} />
      <span className="absolute -top-1 h-5 border-l border-foreground/60" style={{ left: `${threshold}%` }} />
      <span aria-hidden="true" className="absolute -top-3 text-xs leading-none text-foreground" style={{ left: `${Math.max(1, Math.min(99, section.score))}%`, transform: "translateX(-50%)" }}>▼</span>
    </div>
    <div className="flex justify-between text-[10px] text-muted-foreground"><span>0 · 낮음</span><span>탐지 기준 {threshold.toFixed(1)}</span><span>높음 · 100</span></div>
    <p className={`mt-3 text-xs font-medium ${section.flagged ? "text-rose-700 dark:text-rose-300" : "text-teal-700 dark:text-teal-300"}`}>
      {section.flagged ? "AI 생성 신호 감지" : "탐지 기준 이하"}
    </p>
    <p className="mt-1 text-[11px] text-muted-foreground">{section.comparison || `이 구간은 탐지 기준을 ${section.flagged ? "넘었습니다." : "넘지 않았습니다."}`}</p>
  </div>;
}

function DetectionCard({ result }: { result: DetectionPresentation }) {
  const [index, setIndex] = useState(() => Math.max(0, result.sections.findIndex(section => section.flagged)));
  const [featureIndex, setFeatureIndex] = useState(0);
  const section = result.sections[index] ?? result.sections[0]!;
  const feature = section.evidence[featureIndex];
  const flagged = result.sections.filter(section => section.flagged).length;
  return <section aria-label="DetectorScope analysis" className="not-prose mt-2 min-w-0 rounded-md border border-border bg-background p-3 text-foreground"
    onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <div className="text-[11px] text-muted-foreground">DetectorScope · {result.scope}</div>
    {result.completedAt && <p className="mt-1 text-[10px] text-muted-foreground">분석 완료 · {new Date(result.completedAt).toLocaleString("ko-KR")}</p>}
    <h3 className={`mt-2 text-base font-semibold ${flagged ? "text-rose-700 dark:text-rose-300" : "text-teal-700 dark:text-teal-300"}`}>{flagged ? "AI 생성 신호 감지" : "AI 탐지 기준 이하"}</h3>
    <p className="mt-1 text-xs leading-5">{result.sections.length}개 구간 중 <strong>{flagged}개</strong>가 기준을 넘었습니다.</p>
    <p className="mt-1 text-[11px] leading-4 text-muted-foreground">AI 작성 여부를 확정하는 결과는 아닙니다.</p>
    <details className="mt-2 text-[11px] leading-5 text-muted-foreground"><summary className="cursor-pointer">구간이란? · 글자 수가 아닌 토큰 기준</summary><p className="mt-1">{DETECTION_WINDOW_EXPLANATION}</p></details>
    {result.sections.length > 1 && <div aria-label="분석 구간 선택" className="mt-3 flex max-h-28 flex-wrap gap-1 overflow-y-auto">
      {result.sections.map((item, i) => <button key={item.number} type="button" aria-pressed={i === index}
        onClick={() => { setIndex(i); setFeatureIndex(0); }}
        className={`rounded border px-2 py-1 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${i === index ? "border-foreground bg-muted" : "border-border hover:bg-muted/60"}`}>
        {item.number}구간 · {item.flagged ? "감지" : "기준 이하"}
      </button>)}
    </div>}
    <ScoreGauge section={section} threshold={result.threshold} />
    <div className="mt-1 border-t border-border pt-3">
      <h4 className="text-xs font-semibold">모델 특징과 본문 확인</h4>
      <p className="mb-2 mt-1 text-[11px] leading-4 text-muted-foreground">특징 이름은 모델의 일반적인 반응 설명입니다. 현재 글에서 고칠 표현인지는 별도로 확인해야 합니다.</p>
      <div className="grid grid-cols-2 gap-2">
        {(["ai", "human"] as const).map(direction => <div key={direction} className="min-w-0">
          <div className={`mb-1 text-[11px] font-medium ${direction === "ai" ? "text-rose-700 dark:text-rose-300" : "text-teal-700 dark:text-teal-300"}`}>{direction === "ai" ? "점수를 높인 모델 특징" : "점수를 낮춘 모델 특징"}</div>
          {section.evidence.map((item, i) => item.direction === direction && <button key={i} type="button" aria-pressed={featureIndex === i}
            onClick={() => setFeatureIndex(i)}
            className={`mb-1 w-full rounded border p-2 text-left text-[11px] leading-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${featureIndex === i ? (direction === "ai" ? "border-rose-400 bg-rose-50 dark:bg-rose-950/40" : "border-teal-400 bg-teal-50 dark:bg-teal-950/40") : "border-border hover:bg-muted/60"}`}>
            <div className="line-clamp-3 break-words"><Markdown text={item.description} /></div>
          </button>)}
          {!section.evidence.some(item => item.direction === direction) && <p className="p-2 text-[11px] text-muted-foreground">표시할 특징 없음</p>}
        </div>)}
      </div>
      {feature && <div aria-label="선택한 특징의 원문 근거" className={`mt-2 rounded border border-border p-3 text-xs leading-6 ${feature.direction === "ai" ? "[&_strong]:bg-rose-200/70 dark:[&_strong]:bg-rose-800/60" : "[&_strong]:bg-teal-200/70 dark:[&_strong]:bg-teal-800/60"}`}>
        <div className="mb-2 font-medium leading-5">본문 확인</div>
        <div className="text-xs leading-5"><Markdown text={feature.verification.replace(/^본문 확인: /, "") || "이 결과에는 실제 본문과 특징 설명의 일치 여부가 확인되어 있지 않습니다. 강조된 단어를 수정 대상으로 해석하지 마세요."} /></div>
        {feature.verifiedExcerpts && <div aria-label="확인된 반복 구절" className="mt-2 max-h-56 overflow-y-auto break-words [&_blockquote]:my-2 [&_strong]:rounded-sm"><Markdown text={feature.verifiedExcerpts} /></div>}
        <details className="mt-3 border-t border-border pt-2">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">모델 반응 위치 · 수정 지시가 아닙니다</summary>
          <p className="my-2 text-[11px] leading-5 text-muted-foreground">강조는 모델 내부 특징이 활성화된 토큰입니다. 앞 문맥에 반응할 수 있어 특징 이름이 해당 단어를 직접 설명하지 않을 수 있습니다.</p>
          <div className="mb-2 font-medium leading-5"><Markdown text={feature.description} /></div>
          <div className="max-h-56 overflow-y-auto break-words [&_blockquote]:my-2 [&_strong]:rounded-sm"><Markdown text={feature.excerpts || "이 특징에 대응하는 본문 위치가 없습니다."} /></div>
        </details>
      </div>}
    </div>
    <p className="mt-3 text-[10px] leading-4 text-muted-foreground">[ ... ] 안의 인용키·표현은 분석에서 제외했습니다. 원문은 수정하지 않았습니다.</p>
    <details className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
      <summary className="cursor-pointer font-medium">점수 해석과 분석 상세</summary>
      <div className="mt-2 max-h-64 overflow-y-auto break-words leading-5 [&_p]:my-2">
        <p>점수는 실제 AI 작성 확률이 아닙니다. 한국어·학술 표현에서 오탐할 수 있습니다. 표시 점수는 반올림되며 판정에는 원래 값을 사용합니다.</p>
        {section.evidence.map((item, i) => <div key={i}>{item.direction === "ai" ? "AI 방향" : "사람 방향"} {item.contribution} · <Markdown text={item.description} /></div>)}
        <Markdown text={result.details} />
      </div>
    </details>
  </section>;
}

/** One renderer for live chat and persisted comment reports; old Markdown stays readable. */
export function AIDetectionResult({ text }: { text: string }) {
  const result = useMemo(() => detectionPresentation(text), [text]);
  if (result) return result.bracketExclusion ? <DetectionCard key={text} result={result} /> :
    <section aria-label="DetectorScope analysis" className="mt-2 rounded-md border border-border p-3 text-xs text-muted-foreground">이전 분석 방식으로 저장된 결과입니다.</section>;
  return <div aria-label="DetectorScope analysis" className="mt-2 max-h-[32rem] overflow-y-auto break-words text-xs leading-5">
    <Markdown text={text.split(/\n+/).join("\n\n")} />
  </div>;
}
