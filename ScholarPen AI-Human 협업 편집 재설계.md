# ScholarPen: AI-Human 협업 편집 재설계

Oct 4, 2026 · @Anselm Jeong

## 배경과 목표

AI를 사용자가 호출하는 도구가 아니라, 같은 문서를 함께 편집하는 공동 저자(peer)로 바꾼다. 사람과 AI는 각자 자기 구역에서 쉬지 않고 편집하고, 코멘트를 주고받으며, 서로를 가로막지 않는다.

**현재 구조의 한계.** 지금 AI는 `텍스트 선택 → 팝업 메뉴 → AIInlineEditPanel → 교체` 순서로만 움직인다. 사용자가 매번 지시해야 하고, 지시하는 동안 AI 결과를 기다리느라 작업이 멈춘다. AI가 먼저 문제를 짚어 주는 일도 없다.

**지향하는 모델.** 여러 사람이 공동 편집할 때처럼 일한다.

- 사용자가 코멘트를 남기면 AI가 해당 부분을 고치고 스레드에 답한다.
- AI도 사용자에게 코멘트를 남긴다(근거 없는 주장, 인용 오류, 논리 비약 등).
- 둘은 동시에 서로 다른 부분을 편집하고, 충돌은 시스템이 막는다.
- AI 편집은 출처가 드러나고, 되돌리거나 수락·거절할 수 있다.

## 기술적 가능성

가능하다. 필요한 핵심 부품은 BlockNote 의존성으로 이미 `node_modules`에 들어 있고, 새로 만들 것은 AI 에이전트 루프와 Webview↔Bun 동기화 provider다.

| 부품 | 현재 위치 | 재설계에서의 역할 |
| --- | --- | --- |
| `yjs`, `y-prosemirror`, `y-protocols` | BlockNote 의존성 | CRDT 동시 편집. AI를 또 하나의 peer로 붙이는 토대 |
| `@blocknote/core` comments (`YjsThreadStore`, comment mark) | core에 포함 | 텍스트 구간에 고정되는 코멘트 스레드 |
| `@handlewithcare/prosemirror-suggest-changes` | xl-ai가 사용 중 | AI 편집을 덮어쓰기가 아닌 수정 제안(track changes)으로 남김 |
| `xl-ai/prosemirror/rebaseTool.ts` | xl-ai 내부 | 문서가 바뀐 뒤 계산된 편집을 최신 문서 위에 다시 얹기 |
| `ai-inline-edit-protection.ts` | 프로젝트 코드 | citation·math·cross-ref를 LLM이 고쳐도 깨지지 않게 보호. 에이전트에서 그대로 재사용 |
| `providers.ts`, `context-builder.ts` | `src/bun/agent/` | 모델 호출과 문맥 구성. 에이전트가 그대로 사용 |

## 목표 아키텍처

AI는 Bun 프로세스에서 자기 Y.Doc 복제본을 들고 있는 독립 peer가 된다. 네트워크 서버는 필요 없고, Yjs 업데이트를 Electrobun RPC로 주고받는 provider 하나만 직접 만든다.

&#91;embedded content: 목표 아키텍처 · 공유 Y.Doc과 두 peer\]

사람이 타이핑하는 동안에도 AI는 다른 블록을 고치고, 코멘트에 답하고, 새 코멘트를 남긴다. 에이전트가 Bun에 있으므로 에디터 탭을 닫거나 화면이 바뻐도 작업이 이어진다.

## 충돌 방지: 세 겹

Yjs는 글자 단위 수렴은 보장하지만 의미 충돌은 막지 못한다. LLM 호출은 10\~60초가 걸리고, 그사이 사용자가 같은 문단을 고칠 수 있다. 그래서 아래 세 겹을 둔다.

1. **영역 lease (Awareness 기반)**
   - AI는 작업 전에 블록이나 섹션을 claim하고, 에디터에 "AI가 §3.2 수정 중" 커서·하이라이트로 표시한다.
   - 사용자 커서가 있는 블록과 최근 N초 안에 사용자가 건드린 블록은 AI가 피한다.
2. **Stale check → rebase 또는 강등**
   - AI는 읽을 때 블록의 base 버전을 기록한다.
   - 쓸 때 블록이 바뀌었으면 작은 변화는 rebase하고, 큰 변화는 편집을 버리고 코멘트로 강등한다("이 문단을 이렇게 바꾸려 했는데 그사이 수정하셨네요. 제안을 남깁니다").
3. **Suggestion mode + 출처 구분**
   - AI 편집은 기본적으로 tracked change로 들어간다. 신뢰 등급을 둔다: 오타·서식은 자동 적용, 내용 변경은 제안.
   - `Y.UndoManager`의 `trackedOrigins`로 사람과 AI의 undo를 분리하고, "이 섹션의 AI 변경 전부 되돌리기"를 제공한다.
   - 모든 편집에 저자(사람/AI) origin을 붙여 색으로 구분한다.

## 코멘트 중심 협업 루프

코멘트 스레드가 사람과 AI 사이의 주된 통로다. 스레드마다 담당자(`@AI` 또는 `@me`)와 상태(open → in-progress → proposed → resolved)를 둔다.

&#91;embedded content: 코멘트 중심 협업 루프 · 양방향\]

예: 사용자가 "이 문단 너무 길어. 2023 메타분석 추가"라고 남기면, AI가 두 문단으로 나누고 인용을 넣은 뒤 "effect size가 맞는지 확인 부탁드립니다"라고 답한다. AI가 건 코멘트는 사용자가 직접 고치거나 `@AI`에게 되넘겨 위 루프로 들어간다.

**피로 관리**가 없으면 AI 코멘트는 금방 스팸이 된다. 섹션당 코멘트 상한, 심각도 임계값, 중복 제거, "이런 지적은 그만" 피드백을 둘 다.

## 기존 구조 변경점

저장 형식, 사이드바, AI 호출 경로 세 곳이 바뀐다.

| 영역 | 현재 | 변경 후 |
| --- | --- | --- |
| 저장 형식 | `.scholarpen.json`(BlockNote JSON)을 약 2초마다 저장 | Y.Doc 바이너리가 원본. JSON은 export·하위호환용 스냅샷. 처음 열 때 JSON에서 Y.Doc으로 한 번 변환 |
| 코멘트 | 없음 | 같은 Y.Doc 안의 `YjsThreadStore`에 저장 |
| 버전 기록 | 없음 | Yjs 스냅샷으로 "어제 이후 AI가 바꾼 것만 보기" |
| `AISidebar` | 채팅 창 | Activity 패널: 스레드, 진행 중인 AI 작업, 대기 중인 제안. 채팅은 하위 기능 |
| AI 호출 | xl-ai `AIExtension` + `AIInlineEditPanel`, selection 기반 | Bun 에이전트를 직접 작성. suggest-changes와 rebase 부품만 재사용. 기존 팝업은 빠른 수동 경로로 남김 |
| 리뷰 기능 | Validate, Deepen, 참고문헌 검증이 패널로 결과 표시 | 같은 분석을 코멘트로 출력하는 리뷰어 에이전트 |

## 리스크와 검증 항목

가장 큰 리스크는 커스텀 블록이 많은 이 에디터에서 Yjs가 문제없이 도는가이며, 1단계 spike에서 먼저 확인한다.

| 리스크 | 검증 방법 | 대안 |
| --- | --- | --- |
| math, figure, citation, note, Quarto 블록이 Collaboration 확장 아래에서 깨짐 | 기존 문서를 Y.Doc으로 변환 후 JSON으로 되돌려 diff | 블록 스펙의 props 직렬화 수정 |
| suggest-changes 마크 + comment 마크 + Yjs 동기화가 함께 동작하지 않음 | 두 peer에서 제안·코멘트를 동시에 만들어 수렴 확인 | 제안을 별도 Y.Map에 두고 미리보기로 표시 |
| Bun에서 블록↔Y.Doc 변환 수단 부재 | `@blocknote/server-util`(미설치)이 Bun에서 도는지 확인 | Y.XmlFragment 직접 조작, 또는 에이전트 실행만 webview의 숨은 에디터에 위임 |
| RPC로 바이너리 Y 업데이트 전송 | Electrobun RPC의 Uint8Array 지원 확인 | base64 인코딩 |
| 로컬 Ollama 모델의 속도·비용 | 백그라운드 리뷰 1회의 지연 측정 | 동시 작업 1개, 예산 상한, 클라우드 모델 선택 |
| AI 코멘트 스팸으로 사용자 피로 | 실제 원고로 주간 코멘트 수와 수락률 기록 | 섹션당 상한, 심각도 임계값, 중복 제거 |

## 단계별 로드맵

여섯 단계로 나누며, 각 단계는 앞 단계가 통과해야 시작한다. 모든 참여자가 peer라서 6단계까지 구조를 바꾸지 않고 확장된다.

1. **Spike: Yjs 적용** — 메모리 provider로 Collaboration 확장을 붙이고 RPC로 Y.Doc을 저장한다. 통과 기준: 기존 문서의 커스텀 블록이 왕복 후 동일.
2. **Comments** — `YjsThreadStore`를 붙이고 사용자를 "나"와 "ScholarPen AI" 둘로 둔다.
3. **코멘트 → AI 편집 루프** — 한 번에 작업 하나, 블록 lease, stale check, 제안 형태 편집, 스레드 답글.
4. **AI가 먼저 코멘트** — idle 섹션을 대상으로 리뷰어 에이전트를 돌린다. Validate·Deepen·참고문헌 검증을 코멘트 출력으로 전환.
5. **자율 작업 구역** — "Methods는 메모를 바탕으로 AI가 초안, Intro는 내가 작성" 같은 zone 지정과 신뢰 등급(Observe / Suggest / Edit).
6. **복수 AI 페르소나** — 통계 리뷰어, Reviewer 2 등 여러 에이전트를 각각 peer로 추가.

### 다음 단계

- [ ] 1단계 spike: 커스텀 블록이 많은 실제 문서로 Yjs 왕복 테스트 (반나절\~하루)
- [ ] `@blocknote/server-util`의 Bun 호환성 확인
- [ ] Electrobun RPC의 바이너리 전송 확인
