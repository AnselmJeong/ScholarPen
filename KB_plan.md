# Knowledge Base 설계 계획

## 개요

ScholarPen의 Knowledge Base는 **별도 앱(scholarwiki)에서 구축·관리**한다. ScholarPen은 KB를 직접 표시하거나 편집하지 않는다. 오직 **AI 채팅과 에디터에서 참고자료로 조회**할 때만 사용한다.

KB는 프로젝트별 서브폴더(`knowledge-base/`)로 존재하며, 검색은 **Bun 내장 SQLite FTS5** (BM25)로 한다. 추가 패키지 없음.

---

## KB 디렉터리 구조 (읽기 전용, ScholarPen 관점)

```
~/ScholarPen/projects/my-paper/
└── knowledge-base/
    ├── raw/                           # 원문 PDF (scholarwiki가 관리)
    ├── summaries/                     # 논문별 요약 (YAML frontmatter + Markdown)
    └── wiki/
        ├── index/
        │   ├── master_index.yaml      # 전체 논문 메타데이터
        │   ├── keyword_registry.yaml  # 키워드 → 논문 ID 매핑
        │   └── reports_index.yaml     # 합성 리포트 목록
        ├── concepts/                  # 개념 파일 (Key positions, 링크)
        └── reports/                   # 합성 분석 문서
```

ScholarPen이 추가로 관리하는 파일:
```
knowledge-base/
└── .kb-index.sqlite                   # FTS5 인덱스 (ScholarPen이 생성·갱신)
```

---

## 검색 엔진: Bun SQLite FTS5

### 선택 근거

- `bun:sqlite`는 Bun 내장, 추가 패키지 없음
- Electrobun 환경 100% 호환 보장
- SQLite FTS5는 BM25 랭킹 네이티브 지원
- 인덱스가 파일로 영속되어 앱 재시작 시 재인덱싱 불필요
- 구문 검색(`"trust game"`), NOT 연산자(`-depression`) 지원
- KB가 영어 논문 위주이므로 FTS5 기본 토크나이저(porter ascii)로 충분

### 인덱스 스키마

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS docs
USING fts5(
  doc_id,        -- "2025 - Duncan et al. - Trust learning..."
  doc_type,      -- "summary" | "concept" | "report"
  title,
  content,       -- Markdown 본문 (frontmatter 제외)
  tokenize = "porter ascii"
);

-- 메타데이터는 별도 일반 테이블
CREATE TABLE IF NOT EXISTS doc_meta (
  doc_id TEXT PRIMARY KEY,
  doc_type TEXT,
  file_path TEXT,
  one_line_finding TEXT,   -- summary의 경우
  year INTEGER,
  authors TEXT,            -- JSON 배열
  related_concepts TEXT    -- JSON 배열
);
```

### 인덱싱 대상

| 소스 | doc_type | 내용 |
|------|----------|------|
| `summaries/*.md` | `summary` | frontmatter 파싱 후 Markdown 본문 |
| `wiki/concepts/*.md` | `concept` | 전체 내용 |
| `wiki/reports/*.md` | `report` | 전체 내용 |

`raw/` PDF는 인덱싱 안 함 (텍스트 추출 불필요, summary가 이미 존재).

### 검색 구현

```typescript
import { Database } from "bun:sqlite";

export class KBSearchEngine {
  private db: Database;

  constructor(kbPath: string) {
    this.db = new Database(`${kbPath}/.kb-index.sqlite`);
    this.db.run("PRAGMA journal_mode = WAL");
  }

  search(query: string, limit = 5): KBSearchResult[] {
    return this.db.query(`
      SELECT
        m.doc_id,
        m.doc_type,
        m.file_path,
        m.one_line_finding,
        m.year,
        m.authors,
        m.related_concepts,
        snippet(docs, 3, '**', '**', '…', 20) AS excerpt,
        bm25(docs) AS score
      FROM docs
      JOIN doc_meta m USING (doc_id)
      WHERE docs MATCH ?
      ORDER BY score           -- bm25() 값이 낮을수록 더 관련성 높음
      LIMIT ?
    `).all(query, limit) as KBSearchResult[];
  }

  buildIndex(kbPath: string): void {
    // summaries/, wiki/concepts/, wiki/reports/ 순회
    // 각 .md 파일 파싱 → FTS5 테이블에 upsert
    // 변경된 파일만 갱신 (mtime 비교)
  }
}
```

### 인덱스 갱신 시점

- **KB 최초 사용 시**: `knowledge-base/` 존재하고 `.kb-index.sqlite`가 없으면 자동 빌드
- **앱 시작 시**: `master_index.yaml`의 mtime과 인덱스의 `last_indexed` 비교 → 변경 시 백그라운드 재인덱싱
- **수동**: 사용자가 AI 사이드바에서 "Rebuild KB Index" 버튼 클릭 (선택적)

---

## AI 채팅 연동 흐름

```
사용자가 AI 사이드바에서 질문 입력
         ↓
해당 프로젝트에 knowledge-base/ 존재하는지 확인
         ↓ (존재하면 + KB 토글 ON)
FTS5로 쿼리 → 상위 3~5개 문서의 메타데이터 + excerpt 추출
         ↓
시스템 프롬프트 앞에 주입
         ↓
Ollama로 스트리밍 응답
```

### 컨텍스트 주입 포맷

```
--- Knowledge Base References ---
[1] Duncan et al. (2025) · meta-analysis
    "Reciprocation rate is the strongest predictor of trust learning (β=3.0)"
    Concepts: trust_game, interpersonal_trust, reciprocity

[2] Preti et al. (2023) · review
    "Epistemic trust is impaired in BPD through hypermentalizing"
    Concepts: borderline_personality_disorder, epistemic_trust
---------------------------------
```

`one_line_finding`과 `related_concepts` 위주로 압축 주입. 토큰 효율을 위해 full summary는 기본 제외. 사용자가 "자세히" 요청하거나 특정 논문 언급 시 해당 summary 전문 추가.

### AI 사이드바 KB 토글

```
[AI Assistant (Ollama)]  ⚙
Context: [Selection] [Page] [Manuscript]
KB: [● ON]                           ← 토글 추가
```

KB가 없는 프로젝트에서는 토글 비활성화.

---

## 백엔드 RPC (최소 범위)

기존 플레이스홀더 `searchKnowledgeBase()` 교체.

```typescript
// KB 상태 확인 (인덱스 존재 여부, 논문 수, 마지막 인덱싱 시각)
getKBStatus(projectPath: string): {
  exists: boolean;
  paperCount: number;
  lastIndexed: number | null;
}

// FTS5 검색
searchKB(projectPath: string, query: string, limit?: number): KBSearchResult[]
// KBSearchResult: { docId, docType, title, year, authors, oneFinding, relatedConcepts, excerpt }

// 인덱스 빌드/갱신 (백그라운드)
buildKBIndex(projectPath: string): void
```

---

## 구현 우선순위

**Phase A — 검색 + 채팅 컨텍스트 주입**
- `src/bun/kb/search.ts`: `KBSearchEngine` 클래스 (FTS5 인덱싱 + 검색)
- `getKBStatus()`, `searchKB()`, `buildKBIndex()` RPC 등록
- AI 사이드바: KB 토글 + 질문 전송 시 자동 검색 → 시스템 프롬프트 주입

**Phase B — 에디터 연동**
- 텍스트 선택 → "Find in KB" → AI 사이드바에 검색 결과 표시

---

## 미결정 사항

1. **KB 검색 자동 트리거 조건** — 모든 질문에 자동 적용? vs. 사용자 명시 토글 활성화 시에만?
2. **주입 문서 수** — 기본 3개? 5개? (컨텍스트 윈도우 대비 토큰 예산)
3. **full summary 주입 조건** — 항상 `one_line_finding`만? vs. 사용자 요청 시 전문?
