# ScholarPen — AI-Assisted Academic Article Writer

## Product Requirements Document (PRD)

**Version**: 0.1.0-draft
**Author**: Anselm
**Date**: 2026-03-28
**Status**: Initial Draft

---

## 1. Executive Summary

ScholarPen은 정신의학·신경과학 분야 연구자를 위한 macOS 네이티브 데스크탑 앱으로, BlockNote 기반의 block-structured rich-text 에디터에 로컬 AI(Ollama)를 결합하여 학술 원고 작성을 가속화한다. Notion AI의 "AI block" UX 패턴을 학술 글쓰기에 특화시키되, citation management, BibTeX 통합, knowledge base RAG 등 연구자 고유의 워크플로우를 네이티브로 지원한다.

핵심 차별점은 **완전한 로컬 실행**이다. Ollama 모델을 통해 모든 AI 기능이 사용자의 Mac에서 동작하며, 민감한 연구 데이터가 외부로 유출되지 않는다. LanceDB 임베딩 벡터 데이터베이스를 통해 사용자의 논문 라이브러리를 knowledge base로 활용하는 RAG 시스템을 내장한다.

---

## 2. Problem Statement

### 2.1 현재 워크플로우의 문제

학술 논문을 작성하는 연구자는 다음과 같은 도구를 오가며 작업한다:

- **원고 작성**: Word, Quarto, Overleaf 등
- **문헌 관리**: Zotero, Mendeley
- **AI 보조**: ChatGPT, Claude (브라우저 탭 전환)
- **참고문헌 검색**: PubMed, Google Scholar (또 다른 브라우저 탭)

이 과정에서 context switching 비용이 크고, AI 도구에 원고 맥락을 매번 다시 전달해야 하며, 클라우드 AI 사용 시 미출판 연구 데이터의 보안 우려가 있다.

### 2.2 Target User

- 정신의학, 신경과학, 임상의학 분야 연구자
- 한국어와 영어로 학술 논문을 작성하는 이중 언어 사용자
- 주로 review article, book chapter, 학위 논문을 작성
- 기존에 Zotero + BibTeX 기반 참고문헌 관리를 하는 연구자

---

## 3. Product Vision

> "연구자가 하나의 앱 안에서 원고를 쓰고, AI의 도움으로 문장을 다듬고, 관련 논문을 검색하고, 인용을 관리할 수 있는 올인원 학술 글쓰기 환경"

### 3.1 Design Principles

1. **Local-first**: 모든 데이터와 AI 추론이 사용자 Mac에서 동작
2. **Context-aware AI**: 에디터 내 현재 원고, knowledge base, selection을 AI에 자동 전달
3. **Citation-native**: DOI → citekey 변환, BibTeX 관리가 에디터에 내장
4. **Block-structured**: Notion처럼 블록 단위로 콘텐츠를 조작하되, 학술 문서 특화 블록 제공
5. **Non-destructive**: AI 수정은 항상 diff/preview로 제시, 사용자가 accept/reject

---

## 4. Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Desktop Shell** | Electrobun (v1+) | TypeScript-only, Bun 런타임, 네이티브 WebView, ~14MB 번들, <50ms 기동 |
| **Editor** | BlockNote (@blocknote/react) | Block-based rich-text, React 컴포넌트, 커스텀 블록/스키마 확장, Notion-like UX |
| **Frontend** | React 19 + Tailwind CSS + Vite | Electrobun의 webview에서 렌더링 |
| **AI Backend** | Ollama (로컬 LLM) | qwen3.5:cloud 등 로컬 모델, REST API (`localhost:11434`) |
| **Embedding** | Ollama embedding models | qwen3-embedding 등 |
| **Vector DB** | LanceDB (embedded, TypeScript SDK) | 서버리스, 프로세스 내 임베딩, zero-config |
| **Web Search** | Ollama + Tavily/SearXNG | 인터넷 검색을 통한 최신 논문/정보 보강 |
| **Citation Data** | OpenAlex API, CrossRef API, Semantic Scholar API | DOI 해석, 메타데이터, citation graph |
| **File Format** | BlockNote JSON (primary), Markdown, .qmd export | 내부 저장은 JSON, 외부 교환은 Markdown/Quarto |

### 4.1 Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Electrobun Shell                       │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Main Process (Bun)                      │ │
│  │                                                     │ │
│  │  ┌───────────┐  ┌──────────┐  ┌─────────────────┐  │ │
│  │  │  Ollama   │  │ LanceDB  │  │  File System    │  │ │
│  │  │  Client   │  │ (embed)  │  │  (projects,     │  │ │
│  │  │           │  │          │  │   .bib files)   │  │ │
│  │  └─────┬─────┘  └────┬─────┘  └────────┬────────┘  │ │
│  │        │              │                  │           │ │
│  │        └──────────────┼──────────────────┘           │ │
│  │                       │                              │ │
│  │              ┌────────┴────────┐                     │ │
│  │              │   RPC Bridge    │                     │ │
│  │              │  (typed, async) │                     │ │
│  │              └────────┬────────┘                     │ │
│  └───────────────────────┼─────────────────────────────┘ │
│  ┌───────────────────────┼─────────────────────────────┐ │
│  │              Webview Process                         │ │
│  │              ┌────────┴────────┐                     │ │
│  │              │   React App     │                     │ │
│  │              │                 │                     │ │
│  │  ┌───────────┴───────────────┐ │                     │ │
│  │  │    BlockNote Editor       │ │                     │ │
│  │  │  ┌─────────────────────┐  │ │                     │ │
│  │  │  │ Custom Blocks:      │  │ │                     │ │
│  │  │  │ - AI Block          │  │ │                     │ │
│  │  │  │ - Citation Block    │  │ │                     │ │
│  │  │  │ - Math Block        │  │ │                     │ │
│  │  │  │ - Figure Block      │  │ │                     │ │
│  │  │  │ - Code Block        │  │ │                     │ │
│  │  │  └─────────────────────┘  │ │                     │ │
│  │  │                           │ │                     │ │
│  │  │  ┌─────────────────────┐  │ │                     │ │
│  │  │  │ AI Panel (sidebar)  │  │ │                     │ │
│  │  │  │ - Chat interface    │  │ │                     │ │
│  │  │  │ - RAG context       │  │ │                     │ │
│  │  │  └─────────────────────┘  │ │                     │ │
│  │  └───────────────────────────┘ │                     │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
  ┌──────────────┐              ┌──────────────┐
  │   Ollama     │              │  Web APIs    │
  │  localhost   │              │  (OpenAlex,  │
  │  :11434      │              │   CrossRef,  │
  │              │              │   Tavily)    │
  └──────────────┘              └──────────────┘
```

### 4.2 Process Communication

Electrobun의 typed RPC를 활용하여 Main ↔ Webview 간 통신:

- **Webview → Main**: AI 요청, 파일 저장/로드, LanceDB 검색, citation 조회
- **Main → Webview**: AI 스트리밍 응답, 검색 결과, 파일 변경 알림

```typescript
// Main process: RPC handler 정의
win.defineRpc({
  handlers: {
    async generateText(prompt: string, context: string) {
      return ollamaClient.chat({ model, messages: [...] });
    },
    async searchKnowledgeBase(query: string) {
      return lancedb.search(query).limit(5).execute();
    },
    async resolveDOI(doi: string) {
      return crossrefClient.resolve(doi);
    },
  }
});
```

---

## 5. Feature Specification

### 5.1 Core Editor (P0 — MVP)

#### 5.1.1 BlockNote 기반 에디터

| Feature | Description |
|---------|-------------|
| **Rich text editing** | Bold, italic, underline, strikethrough, code, highlight |
| **Block types** | Paragraph, Heading (1-3), Bullet list, Numbered list, Check list, Code block, Blockquote |
| **Block operations** | Drag & drop 재배열, nesting (indent/outdent), slash menu (`/`) 명령 |
| **Keyboard shortcuts** | Cmd+B, Cmd+I 등 표준 단축키, Cmd+Z/Y undo/redo |
| **Markdown 호환** | Markdown 붙여넣기 시 자동 변환, Markdown 내보내기 |

#### 5.1.2 학술 특화 블록 (Custom Blocks)

| Block Type | Description | Props |
|------------|-------------|-------|
| `citationBlock` | 인라인 citation marker, e.g. `[@park2024]` | `citekey`, `displayStyle` (author-year, numeric) |
| `mathBlock` | KaTeX/MathJax 수식 블록 | `latex`, `displayMode` (inline/block) |
| `figureBlock` | 캡션 + 번호가 붙는 figure | `src`, `caption`, `label`, `width` |
| `tableBlock` | 학술 테이블 (caption 포함) | `caption`, `label`, `data` |
| `abstractBlock` | 구조화된 Abstract 섹션 | `sections` (Background, Methods, Results, Conclusion) |
| `footnoteInline` | 각주 인라인 콘텐츠 | `content` |

#### 5.1.3 문서 관리

- **Project 단위 관리**: 하나의 프로젝트 = 하나의 원고 + .bib 파일 + knowledge base
- **자동 저장**: BlockNote JSON으로 로컬 파일 시스템에 자동 저장 (debounced, 2초)
- **버전 히스토리**: Git-like 스냅샷 (수동 save point)
- **파일 구조**:

```
~/ScholarPen/
└── projects/
    └── my-paper/
        ├── manuscript.scholarpen.json   # BlockNote JSON document
        ├── references.bib              # BibTeX file
        ├── knowledge-base/             # PDFs, notes for RAG
        │   ├── papers/
        │   └── notes/
        ├── figures/
        ├── exports/                    # Generated .md, .qmd, .docx
        └── .lance/                     # LanceDB vector store
```

### 5.2 AI Features (P0 — MVP)

#### 5.2.1 AI Block (Notion AI 패턴)

스크린샷에서 보여준 것과 동일한 UX:

1. 사용자가 `/ai` 또는 블록 메뉴에서 "AI Block" 선택
2. AI Block UI가 에디터 내에 인라인으로 등장:
   - **Generate** 드롭다운: Custom output / Continue writing / Summarize / Expand / ...
   - **프롬프트 입력 영역**: 자유 텍스트로 지시
   - **Using** 컨텍스트 선택: Current page only / Selected text / Knowledge base / Specific document
   - **Done** 버튼: 생성된 결과를 에디터에 삽입
3. AI 응답은 스트리밍으로 AI Block 내부에 실시간 표시
4. 사용자가 "Done"을 누르면 AI Block 내용이 일반 블록으로 변환되어 문서에 삽입

#### 5.2.2 Selection-based AI Actions

텍스트를 선택하면 floating toolbar에 AI 버튼이 나타남:

| Action | Description |
|--------|-------------|
| **Paraphrase** | 선택 텍스트를 학술적 어조로 재작성 |
| **Expand** | 선택 텍스트를 기반으로 문단 확장 |
| **Summarize** | 선택 텍스트 요약 |
| **Translate** | 한↔영 번역 (학술 register 유지) |
| **Improve** | 문법, 어휘, 문체 개선 제안 (diff 표시) |
| **Simplify** | 복잡한 문장을 간결하게 |
| **Make formal** | 구어체 → 학술 문어체 변환 |
| **Find citations** | 선택 텍스트 주장에 대한 인용 후보 검색 |

#### 5.2.3 AI Sidebar Chat

에디터 우측에 toggle 가능한 AI 채팅 패널:

- 현재 원고 전체를 컨텍스트로 자동 포함
- Knowledge base RAG를 통한 관련 논문 참조
- 대화 내역 유지 (세션 단위)
- 응답에서 텍스트 블록을 드래그하여 에디터에 삽입 가능

### 5.3 Citation Management (P0 — MVP)

#### 5.3.1 DOI → Citekey 변환

- DOI를 입력하거나 붙여넣으면 자동으로 메타데이터 조회 (CrossRef/OpenAlex)
- Citekey 자동 생성: `@{firstAuthorLastName}{year}{titleFirstWord}` 패턴
- BibTeX 엔트리 자동 생성 및 프로젝트 `.bib` 파일에 추가

```
입력: 10.1038/s41586-024-07238-x
출력: @smith2024neural
      → references.bib에 완전한 BibTeX 엔트리 추가
      → 에디터에 [@smith2024neural] 인라인 citation 삽입
```

#### 5.3.2 Citation Inline Content

- `@` 입력 시 suggestion menu에 기존 citekey 목록 표시
- 선택 시 `[@citekey]` 형식의 citation inline content 삽입
- Citation inline content는 hover 시 논문 제목/저자 tooltip 표시
- 복수 citation 지원: `[@park2024; @kim2023]`

#### 5.3.3 BibTeX 관리 패널

- 프로젝트 `.bib` 파일의 엔트리 목록, 검색, 편집
- Duplicate 감지
- 사용되지 않는 엔트리 표시
- BibTeX 파일 import/export

### 5.4 Knowledge Base & RAG (P1)

#### 5.4.1 Knowledge Base 구성

- PDF 논문 업로드 → 텍스트 추출 → chunk 분할 → 임베딩 생성 → LanceDB 저장
- Markdown 노트 파일도 knowledge base에 포함 가능
- 메타데이터 저장: 제목, 저자, 연도, DOI, 원본 파일 경로

#### 5.4.2 RAG Pipeline

```
User query / selected text
        │
        ▼
┌──────────────────┐
│ Ollama embedding │  (nomic-embed-text)
│ model            │
└────────┬─────────┘
         │ query vector
         ▼
┌──────────────────┐
│    LanceDB       │  hybrid search (vector + FTS)
│    search        │
└────────┬─────────┘
         │ top-k chunks with metadata
         ▼
┌──────────────────┐
│ Context assembly │  query + retrieved chunks + current document context
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   Ollama LLM     │  (llama3.1, gemma2, etc.)
│   generation     │
└────────┬─────────┘
         │ streamed response
         ▼
     Editor / AI Panel
```

#### 5.4.3 LanceDB Schema

```typescript
interface KnowledgeChunk {
  id: string;                    // unique chunk ID
  doc_id: string;                // parent document ID
  text: string;                  // chunk text content
  vector: Float32Array;          // embedding vector
  metadata: {
    title: string;
    authors: string[];
    year: number;
    doi?: string;
    source_file: string;
    chunk_index: number;
    section?: string;            // e.g., "Introduction", "Methods"
  };
}
```

### 5.5 Web Search Integration (P1)

- Ollama 모델이 판단하여 웹 검색이 필요한 경우 자동 트리거
- 또는 사용자가 명시적으로 "Search web" 모드 선택
- 검색 결과를 RAG context에 추가하여 응답 생성
- 학술 검색 소스: PubMed, Semantic Scholar, Google Scholar (via SearXNG)

### 5.6 Export (P1)

| Format | Method | Notes |
|--------|--------|-------|
| **Markdown** | `blocksToMarkdownLossy` + citation 후처리 | Pandoc-compatible citation syntax |
| **Quarto (.qmd)** | Markdown + YAML frontmatter | 학술 논문 메타데이터, bibliography 필드 포함 |
| **HTML** | `blocksToFullHTML` | 미리보기/공유용 |
| **DOCX** | Pandoc 변환 (Markdown → DOCX) | 학술지 제출용, citation 스타일 적용 |
| **PDF** | Pandoc/Quarto → PDF | LaTeX 템플릿 기반 |
| **BibTeX** | 직접 내보내기 | 사용된 citation만 필터링 옵션 |

---

## 6. UI/UX Design

### 6.1 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ◀ ▶  ScholarPen        [project name]        ⚙️  AI ☰     │
├────────────┬────────────────────────────────┬────────────────┤
│            │                                │                │
│  Project   │        Editor Area             │   AI Sidebar   │
│  Sidebar   │                                │   (toggle)     │
│            │  ┌──────────────────────────┐  │                │
│  📁 Docs   │  │  [Formatting Toolbar]    │  │  💬 Chat       │
│  📚 Refs   │  │                          │  │  📎 Context    │
│  🔍 Search │  │  Block content here...   │  │  📝 History    │
│  📂 KB     │  │                          │  │                │
│            │  │  ┌─ AI Block ──────────┐ │  │                │
│            │  │  │ Generate: [Custom▾] │ │  │                │
│            │  │  │                     │ │  │                │
│            │  │  │ [AI output here...] │ │  │                │
│            │  │  │                     │ │  │                │
│            │  │  │ Using: [Page ▾]     │ │  │                │
│            │  │  └─────────── [Done] ──┘ │  │                │
│            │  │                          │  │                │
│            │  │  More blocks...          │  │                │
│            │  └──────────────────────────┘  │                │
│            │                                │                │
├────────────┴────────────────────────────────┴────────────────┤
│  Status: Ollama ● connected | Model: llama3.1 | Words: 2,451│
└─────────────────────────────────────────────────────────────┘
```

### 6.2 AI Block 상세 UX Flow

```
[사용자가 /ai 입력 또는 블록 메뉴에서 AI Block 선택]
        │
        ▼
┌── AI Block (inline) ──────────────────────────────────┐
│                                                        │
│  Generate: [ Custom output           ▾]    [Done]      │
│            ┌─────────────────────────┐                 │
│            │ Custom output           │                 │
│            │ Continue writing         │                 │
│            │ Summarize               │                 │
│            │ Expand paragraph         │                 │
│            │ Write introduction       │                 │
│            │ Find citations           │                 │
│            │ Translate to English     │                 │
│            │ Translate to Korean      │                 │
│            └─────────────────────────┘                 │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ [User prompt area - contenteditable]             │  │
│  │                                                  │  │
│  │ "이 문단을 이어받아 써줘. FEP의 기본 수식에     │  │
│  │  대한 친절한 안내를 시도하되, formal한 문체로..." │  │
│  └──────────────────────────────────────────────────┘  │
│                                                    [@] │
│  Using: [ 📄 Current page only — 📄 서론     ▾]       │
│         ┌─────────────────────────┐                    │
│         │ Current page only       │                    │
│         │ Selected text           │                    │
│         │ Entire manuscript       │                    │
│         │ Knowledge base          │                    │
│         │ Specific document...    │                    │
│         └─────────────────────────┘                    │
└────────────────────────────────────────────────────────┘
        │
        ▼ [사용자가 Enter 또는 Generate 클릭]
        │
┌── AI Block (streaming response) ──────────────────────┐
│                                                        │
│  ████████░░░░ Generating...                [Stop]      │
│                                                        │
│  "자유 에너지 원리의 핵심 수식은 변분 자유 에너지      │
│   F를 최소화하는 과정으로 표현된다. 이는 크게 두       │
│   항으로 구성되는데, 기대 에너지(expected energy)와     │
│   엔트로피(entropy)의 합으로..."                       │
│                                                        │
│  Using: [ 📄 Current page only — 📄 서론     ▾]       │
│                                                        │
│  [Insert below] [Replace selection] [Copy] [Retry]     │
└────────────────────────────────────────────────────────┘
```

### 6.3 Selection-based AI Toolbar

```
텍스트 선택 시:

"이처럼 정신병리의 이해와 새로운 개념화..."
 ████████████████████████████████████████
        │
        ▼
┌─────────────────────────────────────────┐
│ B  I  U  S  🔗  🎨  │  🤖 AI ▾        │
│                       │ ┌─────────────┐ │
│                       │ │ Paraphrase  │ │
│                       │ │ Expand      │ │
│                       │ │ Summarize   │ │
│                       │ │ Translate   │ │
│                       │ │ Improve     │ │
│                       │ │ Find refs   │ │
│                       │ │ Custom...   │ │
│                       │ └─────────────┘ │
└─────────────────────────────────────────┘
```

### 6.4 Theming

- **Light/Dark mode** 기본 지원 (macOS 시스템 설정 연동)
- 학술 문서에 적합한 serif/sans-serif 전환
- 기본 폰트: Noto Serif KR (본문), Inter (UI), JetBrains Mono (코드)

---

## 7. Data Flow

### 7.1 Document Save/Load

```
Save:
  editor.document (Block[])
    → JSON.stringify
    → fs.writeFile("manuscript.scholarpen.json")
    → debounced 2초

Load:
  fs.readFile("manuscript.scholarpen.json")
    → JSON.parse → PartialBlock[]
    → useCreateBlockNote({ initialContent })
```

### 7.2 AI Generation Flow

```
1. User trigger (AI Block / selection action / sidebar chat)
2. Context assembly:
   a. System prompt (학술 글쓰기 전문가 역할)
   b. Current document context (선택된 scope에 따라)
   c. RAG context (LanceDB 검색 결과, 선택적)
   d. User instruction
3. Ollama API call:
   POST http://localhost:11434/api/chat
   {
     model: "qwen3.5:cloud",
     messages: [...assembled context...],
     stream: true
   }
4. Streaming response → UI 실시간 업데이트
5. User action: Insert / Replace / Copy / Discard
```

### 7.3 Citation Resolution Flow

```
1. User inputs DOI (paste, manual entry, or AI suggestion)
2. Main process: CrossRef API → metadata (title, authors, year, journal, ...)
3. Generate citekey: @{lastName}{year}{word}
4. Generate BibTeX entry
5. Append to project's references.bib
6. Insert citation inline content [@citekey] in editor
7. Update citation autocomplete index
```

### 7.4 Knowledge Base Ingestion

```
1. User adds PDF to project's knowledge-base/papers/
2. Main process detects new file (fs.watch)
3. PDF text extraction (pdf-parse or pdfjs-dist)
4. Text chunking (512 tokens, 50 token overlap)
5. Metadata extraction (title, authors from PDF or CrossRef)
6. Ollama embedding generation (nomic-embed-text)
7. LanceDB upsert: chunks + vectors + metadata
8. UI notification: "📚 Added: Park et al. 2024 — Neural mechanisms of..."
```

---

## 8. Ollama Integration Detail

### 8.1 Required Models

| Purpose | Model | Size | Notes |
|---------|-------|------|-------|
| **Text generation** | `qwen3.5:cloud` | ~4.7GB | Primary writing model |
| **Text generation (advanced)** | `qwen3.5:cloud` | ~40GB | 고품질 출력, M2 Ultra+ 권장 |
| **Embedding** | `qwen3-embedding` | ~274MB | 768-dim, knowledge base용 |
| **Code/LaTeX** | `qwen3.5:cloud` | ~4.7GB | 수식, 코드 블록 지원 |

### 8.2 Ollama API Usage

```typescript
// Text generation (streaming)
const response = await fetch("http://localhost:11434/api/chat", {
  method: "POST",
  body: JSON.stringify({
    model: "qwen3.5:cloud",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    stream: true,
  }),
});

// Embedding generation
const response = await fetch("http://localhost:11434/api/embed", {
  method: "POST",
  body: JSON.stringify({
    model: "qwen3-embedding",
    input: ["text to embed"],
  }),
});
```

### 8.3 System Prompts

학술 글쓰기 특화 시스템 프롬프트 템플릿:

```
You are an expert academic writing assistant specializing in psychiatry,
neuroscience, and clinical medicine. You write in formal academic register
appropriate for peer-reviewed journals.

Guidelines:
- Maintain precise scientific terminology
- Preserve all citation markers exactly as written (e.g., [@park2024])
- When continuing text, match the style, tone, and complexity of the
  preceding paragraphs
- Support both Korean and English academic writing
- When suggesting citations, provide DOIs when possible
- Use hedging language appropriately for scientific claims
```

---

## 9. Development Phases

### Phase 1: Foundation (4 weeks)

- [ ] Electrobun 프로젝트 scaffolding (React + Vite + Tailwind)
- [ ] BlockNote 에디터 통합, 기본 블록 타입 동작 확인
- [ ] Main ↔ Webview RPC 통신 구조 수립
- [ ] 프로젝트 파일 시스템 (생성, 저장, 로드)
- [ ] 기본 UI 레이아웃 (3-column: sidebar, editor, AI panel)

### Phase 2: AI Core (4 weeks)

- [ ] Ollama 클라이언트 (Main process, 연결 상태 관리)
- [ ] AI Block 커스텀 블록 구현 (BlockNote `createReactBlockSpec`)
- [ ] AI Block UX: Generate 모드 선택, 프롬프트 입력, 컨텍스트 선택
- [ ] Streaming 응답 렌더링
- [ ] Selection-based AI actions (formatting toolbar 확장)
- [ ] AI Sidebar chat panel

### Phase 3: Citation (3 weeks)

- [ ] DOI resolution (CrossRef/OpenAlex API 통합)
- [ ] BibTeX parser/writer
- [ ] Citation inline content 커스텀 블록
- [ ] `@` trigger suggestion menu (citekey 자동완성)
- [ ] BibTeX 관리 패널 (sidebar tab)
- [ ] Citekey 생성 규칙 설정

### Phase 4: Knowledge Base (3 weeks)

- [ ] LanceDB 통합 (embedded TypeScript SDK)
- [ ] PDF 텍스트 추출 파이프라인
- [ ] Chunking + embedding pipeline (Ollama)
- [ ] RAG 검색 → AI 컨텍스트 주입
- [ ] Knowledge base 관리 UI (파일 추가/삭제, 인덱싱 상태)

### Phase 5: Export & Polish (2 weeks)

- [ ] Markdown 내보내기 (citation syntax 포함)
- [ ] Quarto (.qmd) 내보내기
- [ ] DOCX 내보내기 (Pandoc 통합)
- [ ] 앱 패키징 (.dmg 생성)
- [ ] 자동 업데이트 (Electrobun updater)
- [ ] 성능 최적화, 메모리 프로파일링

---

## 10. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Electrobun 미성숙** | 프레임워크 버그, 문서 부족 | Electron fallback plan 유지; Electrobun community 참여 |
| **Ollama 모델 품질** | 학술 한국어 생성 품질 불균일 | 모델 선택 UI 제공; fine-tuned model 지원; 프롬프트 엔지니어링으로 보완 |
| **LanceDB TS SDK 제약** | 일부 고급 검색 기능 미지원 | Python sidecar fallback; LanceDB 로드맵 추적 |
| **대용량 원고 성능** | 수백 블록 문서에서 렌더링 지연 | BlockNote의 virtualization, lazy rendering 활용 |
| **PDF 텍스트 추출 품질** | 2-column 레이아웃, 수식 등에서 깨짐 | GROBID 등 학술 PDF 전용 파서 검토; 수동 교정 UI |

---

## 11. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| 원고 1개 섹션 초안 작성 시간 | 기존 대비 40% 단축 | 사용자 self-report |
| DOI → citation 삽입 시간 | < 5초 | 앱 내 측정 |
| AI 응답 첫 토큰 시간 (TTFT) | < 2초 (8B 모델 기준) | 앱 내 측정 |
| 앱 번들 크기 | < 30MB (Ollama 제외) | 빌드 출력 |
| 앱 기동 시간 | < 1초 | 측정 |
| Knowledge base 검색 응답 시간 | < 500ms (10k chunks) | 앱 내 측정 |

---

## 12. Future Considerations (P2+)

- **Collaboration**: YJS 기반 실시간 공동 편집
- **Template system**: 학술지별 포맷 템플릿 (Nature, PNAS, 한국정신의학 등)
- **Citation style switching**: APA, Vancouver, Chicago 등 CSL 기반
- **Outline mode**: 전체 문서 구조를 outline view로 탐색/재배열
- **Zotero 연동**: Zotero API를 통한 라이브러리 동기화
- **Multi-document project**: 단행본(book) 수준의 다중 챕터 관리
- **Plugin system**: 사용자/커뮤니티 확장 블록, AI 프롬프트 템플릿
- **Cloud sync**: 선택적 클라우드 동기화 (E2E encrypted)

---

## 13. Glossary

| Term | Definition |
|------|------------|
| **Block** | BlockNote의 기본 콘텐츠 단위 (paragraph, heading, list item 등) |
| **Citekey** | BibTeX 참조 키, e.g., `@park2024neural` |
| **RAG** | Retrieval-Augmented Generation — 검색 결과를 LLM 컨텍스트에 주입하는 기법 |
| **TTFT** | Time To First Token — AI 응답의 첫 토큰이 표시되기까지의 시간 |
| **Knowledge Base** | 프로젝트에 연결된 참고 문헌/노트의 벡터 인덱스 |
| **Electrobun** | TypeScript + Bun 기반 경량 데스크탑 앱 프레임워크 |
| **LanceDB** | 임베딩 벡터 데이터베이스 (embedded, serverless) |
| **Ollama** | 로컬 LLM 실행 프레임워크 |
