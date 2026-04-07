# ScholarPen — macOS Desktop App 구현 계획

**Status**: In Progress  
**Created**: 2026-04-06  
**PRD**: PRD.md

---

## 1. 요구사항 재확인

PRD 기반 핵심 목표:
- **Electrobun** 셸 + **BlockNote** 에디터 + **Ollama** 로컬 AI의 3-tier 통합
- 완전 로컬 실행 (클라우드 전송 없음)
- 학술 특화 블록 + citation 관리 + Knowledge Base RAG

---

## 2. 리스크 평가

| 리스크 | 수준 | 대응 |
|--------|------|------|
| Electrobun 성숙도 — v1, 커뮤니티 작음 | HIGH | 초기에 Electrobun RPC 패턴을 PoC로 검증 |
| BlockNote `AIExtension` — Ollama 직접 연결 필요 | MEDIUM | `transport` 옵션으로 Ollama REST 연결 커스터마이징 |
| LanceDB TypeScript SDK — Bun 환경 호환성 미검증 | HIGH | Phase 0에서 Bun + LanceDB 단독 실행 검증 필수 |
| PDF 파싱 (Bun 환경) — Node.js 라이브러리 호환 불확실 | MEDIUM | `pdftotext` CLI fallback 또는 `pdf-parse` 대체 고려 |
| Pandoc 의존성 — DOCX/PDF export에 시스템 Pandoc 필요 | LOW | 앱 번들 포함 또는 사용자 설치 안내 |
| @blocknote/xl-docx-exporter — PDF export는 react-pdf 기반 | LOW | PRD의 Pandoc 방식과 병행 검토 |

---

## 3. 아키텍처 결정 사항

1. **Vite 번들 위치**: 개발 → dev server, 배포 → 정적 번들
2. **BlockNote AI 방식**: 내장 `AIExtension` 활용 (streaming, diff/accept UI 내장)
3. **RPC 타입 공유**: 모노레포 `packages/shared-types`
4. **Citation 인라인 방식**: BlockNote `InlineContent` 커스텀 타입으로 구현

---

## 4. 프로젝트 구조

```
scholarpen/
├── apps/
│   ├── main/                    # Electrobun Main Process (Bun)
│   │   └── src/
│   │       ├── rpc/             # RPC 핸들러
│   │       ├── ollama/          # Ollama client
│   │       ├── lancedb/         # Vector DB
│   │       ├── citation/        # CrossRef / OpenAlex client
│   │       └── fs/              # 파일 시스템 관리
│   └── renderer/                # Webview React App
│       └── src/
│           ├── editor/          # BlockNote 에디터 + custom blocks
│           ├── blocks/          # 학술 커스텀 블록
│           ├── ai/              # AI 관련 컴포넌트
│           ├── citation/        # Citation UI
│           └── sidebar/         # AI sidebar, project sidebar
└── packages/
    └── shared-types/            # Main/Webview 공유 타입
```

---

## 5. 구현 단계

### Phase 0: 스캐폴딩 & 환경 검증 ✓ 완료
- [x] Electrobun 앱 초기화, Bun 워크스페이스 설정
- [x] Vite + React 19 + Tailwind CSS Webview 설정
- [x] PoC 검증: Bun + LanceDB 동작 여부 (✓)
- [x] PoC 검증: Ollama 연결 확인 (Connected, 모델: gemma4, minimax-m2.7)
- [x] PoC 검증: Ollama streaming 정상 동작 (✓)
- [x] BlockNote 기본 에디터 Webview 렌더링 (Vite build ✓)

### Phase 1: 핵심 에디터 (P0-MVP) ✓ 완료
- [x] `useCreateBlockNote` + `BlockNoteView` 기본 구성
- [x] Slash menu, 커스텀 포매팅 툴바
- [x] `mathBlock` (KaTeX, block 렌더링 + 인라인 편집)
- [x] `citationInline` (InlineContent 타입, [@citekey])
- [x] `figureBlock` (이미지 + 캡션 + 번호)
- [x] `abstractBlock` (구조화 섹션)
- [x] `footnoteInline` (인라인 각주, hover tooltip)
- [x] 프로젝트 파일 시스템 RPC (~/ScholarPen/projects/)
- [x] `manuscript.scholarpen.json` 자동 저장 (2초 debounce)
- [x] 3-pane 레이아웃 (Project Sidebar / Editor / AI Sidebar)
- [x] Status bar (Ollama 상태, 모델명, 단어수)
- NOTE: `tableBlock` — BlockNote 내장 table 블록 사용 (caption은 Phase 5 export 시 처리)

### Phase 2: AI 기능 (P0-MVP) ← 다음 단계
- [ ] `AIExtension` + Ollama transport 연결
- [ ] AI Block (`/ai` slash command)
- [ ] Generate 드롭다운 (Custom / Continue / Summarize / Expand / Translate)
- [ ] Using 컨텍스트 선택 (Page / Selection / Manuscript / KB)
- [ ] Selection-based AI Toolbar (Paraphrase, Expand, Summarize, Translate, Improve, Simplify, Formal, Find refs)
- [ ] Diff 미리보기 + accept/reject
- [ ] AI Sidebar Chat (`sendMessageWithAIRequest`)
- [ ] 대화 히스토리 유지

### Phase 3: Citation 관리 (P0-MVP)
- [ ] DOI 해석 RPC (CrossRef API → citekey 자동 생성)
- [ ] BibTeX 엔트리 자동 생성 + references.bib 추가
- [ ] `@` 입력 → suggestion menu → citekey 목록
- [ ] Hover tooltip (제목/저자/연도)
- [ ] 복수 citation 지원
- [ ] BibTeX 관리 패널 (목록, 검색, 편집, 중복 감지)
- [ ] OpenAlex / Semantic Scholar 연동 (Find citations)

### Phase 4: Knowledge Base & RAG (P1)
- [ ] PDF 업로드 → 텍스트 추출 → Chunk 분할
- [ ] Ollama embedding → LanceDB 저장
- [ ] `KnowledgeChunk` LanceDB 스키마
- [ ] `searchKnowledgeBase(query)` hybrid search RPC
- [ ] AI Block "Knowledge base" 컨텍스트 연결
- [ ] AI Sidebar Chat RAG 자동 트리거
- [ ] KB 관리 UI (파일 목록, 인덱싱 상태)

### Phase 5: Export (P1)
- [ ] Markdown export (`blocksToMarkdownLossy` + citation 후처리)
- [ ] Quarto (.qmd) export (Markdown + YAML frontmatter)
- [ ] DOCX export (`@blocknote/xl-docx-exporter` or Pandoc)
- [ ] PDF export
- [ ] BibTeX export (사용된 citation 필터링)

---

## 6. 의존성 & 순서

```
Phase 0 (필수 선행)
  └─► Phase 1 (에디터)
        └─► Phase 2 (AI) ──┐
        └─► Phase 3 (Citation) ──┼─► Phase 5 (Export)
              └─► Phase 4 (RAG) ──┘
```

---

## 7. 복잡도 추정

| Phase | 복잡도 | 예상 작업 단위 |
|-------|--------|---------------|
| Phase 0: 스캐폴딩 | MEDIUM | 3-4 세션 |
| Phase 1: 에디터 | HIGH | 6-8 세션 |
| Phase 2: AI | HIGH | 6-8 세션 |
| Phase 3: Citation | MEDIUM | 4-5 세션 |
| Phase 4: KB & RAG | HIGH | 5-6 세션 |
| Phase 5: Export | LOW | 2-3 세션 |

---

## 8. 기술 스택 참조

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electrobun (v1+) — TypeScript/Bun |
| Editor | @blocknote/react + @blocknote/mantine |
| AI Extension | @blocknote/xl-ai-backend + AIExtension |
| Frontend | React 19 + Tailwind CSS + Vite |
| AI Backend | Ollama (localhost:11434) |
| Embedding | nomic-embed-text via Ollama |
| Vector DB | LanceDB (@lancedb/lancedb) |
| Citation | CrossRef API, OpenAlex API |
| Export | @blocknote/xl-docx-exporter, Pandoc |
