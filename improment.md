# ScholarPen Improvement Plan

작성일: 2026-04-18

이 문서는 현재 코드 반영 상태를 기준으로 남은 개선을 중요도순으로 재구성한 것이다. 사용자가 의도한 `AISidebar` 구조, `ollama launch claude`, Claude direct option, `--dangerously-skip-permissions`는 수정 대상이 아니다. 목표는 권한 제거가 아니라 project scope, abort, URL 검증, 오류 표시 같은 guardrail 강화다.

## 현재 완료된 항목

- TypeScript 타입체크 실패 수정.
- `react-icons` transitive 의존 제거 또는 직접 의존성 정리.
- `prosemirror-*`, `pdfjs-dist`, `yaml` 직접 의존성 등록.
- KB `year` 파싱 조건 수정.
- KB YAML parser를 표준 `yaml` parser로 교체.
- renderer 입력 기반 file/project path validation 추가.
- auto-save/manual-save status race 완화.
- `.scholarpen.json`/`.bib` 변경 이벤트에 file path 포함.
- 초기 theme 적용을 render 전에 처리.
- BibTeX read-only 해소: raw edit/save/revert, entry table, duplicate review, unused entry scan/remove, parse issue 표시.
- BibTeX editor를 `FileViewer`에서 분리하고 preview/table/review 렌더링 상한 추가.
- PDF CMap을 CDN이 아니라 app bundle `dist/cmaps`에서 제공.
- 큰 PDF에 80MB guard 추가. 현재 사용 범위에서는 PDF streaming/custom protocol 전환은 보류한다.
- Renderer feature chunk 분리. Build 기준 main JS는 약 278 kB까지 축소됨. `vendor-editor`와 `pdf.worker` size warning은 남지만 앱 시작 chunk에서는 분리됨.
- File tree scan을 directory level `Promise.all`로 병렬화.
- Settings의 `ollamaBaseUrl`을 main Ollama client와 renderer BlockNote transport에 반영.
- `kbTopK`를 KB search와 Claude context injection에 반영.
- `openExternal`은 `http:`/`https:` URL만 허용하도록 제한.
- Claude stop 버튼을 실제 subprocess abort/kill 경로에 연결.
- AISidebar header에 agent mode 권한 상태 badge 추가.

## P0: 지금 우선 해결해야 하는 안정성 항목

### 1. Claude agent lifecycle guardrail 보강

현재 반영:

- `abortClaudeStream` RPC 추가.
- 새 Claude stream 시작 시 이전 stream abort.
- Stop 버튼이 UI 상태만 바꾸지 않고 subprocess kill까지 요청.
- Sidebar header에 agent mode badge 표시.

남은 개선:

- Claude stream start/end/abort/error 로그를 더 구조화한다.
- Claude subprocess `cwd`가 항상 active project path로 제한되는지 runtime log로 확인한다.

코드 반영 위험:

- 낮음. 다만 abort timing에 따라 이미 도착한 chunk가 뒤늦게 UI에 들어올 수 있으므로 listener의 aborted guard는 유지해야 한다.

### 2. KB search의 Korean/CJK 검색 품질 개선

문제:

- 현재 FTS5 tokenizer가 `porter ascii`라 Korean/CJK query 품질이 낮을 수 있다.
- `safeFtsQuery()`는 Unicode를 보존하지만 tokenizer 단계에서 기대한 검색 품질이 나오지 않을 가능성이 있다.

개선 방향:

- ASCII/English는 현재 FTS를 유지한다.
- Korean/CJK가 포함된 query는 application-level substring fallback 또는 ngram/trigram index를 추가한다.
- UI 또는 코드 주석에 현재 검색 한계를 명확히 한다.

코드 반영 위험:

- 중간. fallback 검색은 recall은 좋아지지만 ranking 품질이 흔들릴 수 있다. ngram index는 rebuild 비용과 index size가 증가한다.

### 3. `openExternal` link 경로 유지 보강

현재 반영:

- main process에서 `http:`/`https:`만 열도록 검증.

남은 개선:

- KB internal link는 URL 문자열 hack이 아니라 별도 RPC/action type으로 처리한다.
- renderer markdown link transform도 동일 정책을 공유하게 한다.

코드 반영 위험:

- 낮음. 단, 기존에 `file:`, `scholarpen:`, anchor-only link를 의도적으로 쓰던 UI가 있으면 차단될 수 있으므로 internal link 흐름을 별도로 만들어야 한다.

## P1: 실제 기능 품질에 영향이 큰 항목

### 1. BibTeX 안전 merge와 citekey rewrite

현재 상태:

- exact citekey, DOI, title-author-year 기반 duplicate review와 제거는 가능하다.
- `.scholarpen.json` 문서에 한 번도 쓰이지 않은 entry 제거도 가능하다.

남은 개선:

- fuzzy title similarity 기반 possible duplicate 후보 추가.
- duplicate group에서 field가 더 완전한 entry를 keep candidate로 제안.
- 제거될 citekey가 문서에서 사용 중이면 keep citekey로 rewrite하는 preview/apply flow 제공.
- cleanup 결과를 `{ kept, removed, rewritten, conflicts }`로 표시.

코드 반영 위험:

- 높음. 잘못 rewrite하면 문서 citation이 깨진다. 반드시 preview, apply, rollback 가능한 흐름으로 구현해야 한다.

### 2. Text find hook을 viewer별 adapter로 분리

문제:

- 현재 `useTextFind`는 DOM Text node를 직접 `<mark>`로 교체한다.
- React Markdown, BibTeX preview, PDF text layer는 모두 render lifecycle이 달라 stale mark나 rerender 충돌이 생길 수 있다.

개선 방향:

- Markdown/code/BibTeX는 source text 기반 highlight rendering으로 전환한다.
- PDF는 PDF.js text layer lifecycle에 맞춘 별도 search adapter를 둔다.
- 공통 hook은 query/current match state만 관리한다.

코드 반영 위험:

- 중간에서 높음. Cmd+F UX 전체에 영향을 주므로 viewer별로 나눠 단계 적용해야 한다.

### 3. KB index parser/fixture 테스트 추가

현재 반영:

- custom YAML parser는 제거하고 `yaml.parse()`를 사용한다.

남은 개선:

- `master_index.yaml`에 여러 `papers` 항목이 있을 때 metadata enrichment가 정상 동작하는 fixture 테스트를 추가한다.
- `keyword_registry.yaml`도 실제 샘플 기반으로 검증한다.

코드 반영 위험:

- 낮음. 테스트 추가 중심이라 regression 방어 효과가 크다.

## P2: 성능/정리 항목

### 1. File tree cache/lazy expansion

현재 상태:

- directory level 병렬화는 완료.

남은 개선:

- `file.path + mtime + size` 기반 cache/diff.
- 큰 directory는 lazy expansion.

코드 반영 위험:

- 중간. stale tree, rename/delete 후 UI 불일치, 외부 변경 이벤트 누락 가능성이 있다. 현재 파일 수가 크지 않으면 지금 당장 필요하지 않다.

### 2. Markdown/code large-file threshold

현재 상태:

- BibTeX는 preview/table/review 렌더링 상한이 있다.
- Markdown/code viewer는 아직 전체 render다.

개선 방향:

- 일정 크기 이상은 preview limit과 “open full raw edit/view” 흐름을 둔다.
- 진짜 virtualization은 필요할 때 별도 도입한다.

코드 반영 위험:

- 낮음에서 중간. 큰 파일은 안정화되지만 작은 파일 UX가 불필요하게 제한되지 않도록 threshold를 보수적으로 잡아야 한다.

### 3. Dead code 정리

후보:

- `src/bun/rpc/handlers.ts`
- `src/renderer/components/sidebar/ProjectSidebar.tsx`
- `createOllamaTransportWithSystemPrompt()`
- legacy manuscript RPC
- 일부 unused shared types/UI primitive exports

코드 반영 위험:

- 낮음에서 중간. 명확한 미사용 파일은 삭제 가능하지만, legacy manuscript RPC는 migration window가 끝났는지 확인 후 제거해야 한다.

## 보류 항목

### PDF local URL/streaming 전환

보류 이유:

- 일반 논문 PDF 위주라면 현재 base64 bridge로 충분하다.
- 80MB guard와 CMap local bundle로 현실적인 안정성은 확보했다.
- custom protocol/file serving은 경로 검증 실패 시 임의 파일 노출 위험이 있다.

재검토 조건:

- 수백 MB 스캔 PDF, 책 PDF, 이미지-heavy PDF를 자주 다루게 될 때.

## 추천 작업 순서

1. Claude agent lifecycle 보강을 마무리한다: 권한 상태 표시, structured lifecycle log.
2. KB Korean/CJK fallback 검색을 설계하고 작게 적용한다.
3. KB parser fixture 테스트를 추가한다.
4. BibTeX citekey rewrite는 preview/apply/rollback 설계 후 별도 작업으로 진행한다.
5. Text find adapter 분리는 viewer별로 나눠 적용한다.
6. file tree cache/lazy expansion과 dead code 정리는 성능 또는 유지보수 압박이 커질 때 진행한다.

## 검증 명령

```bash
./node_modules/.bin/tsc --noEmit
bun run build:release
git diff --check
```
