---
name: qmd search library
description: qmd(@tobilu/qmd)의 기능, Electrobun 호환성 평가, ScholarPen KB 검색 전략 결정
type: project
---

## qmd란

`@tobilu/qmd` — 로컬 온디바이스 Markdown 검색 엔진 (https://github.com/tobi/qmd).

세 가지 검색 모드:
- `searchLex()` — BM25 전문 검색, SQLite 기반, **embedding/GGUF 불필요**
- `search()` — 하이브리드 (BM25 + 벡터 + LLM 재랭킹), node-llama-cpp + GGUF 필요
- `vsearch()` — 벡터 검색만, node-llama-cpp + GGUF 필요

TypeScript/Node.js SDK (`import { createStore } from '@tobilu/qmd'`). Bun 공식 지원 (`bun install -g @tobilu/qmd` README에 명시).

쿼리 문법: 구문 검색 `"trust game"`, 제외 `-depression`, 조합 가능.

MCP 서버 기능 내장 (Claude Code/Desktop 연동 가능).

## Electrobun 환경 호환성 판정

| 기능 | 판정 | 이유 |
|------|------|------|
| `searchLex()` (BM25) | ✅ 이론상 가능 | 순수 SQLite, 네이티브 모듈 불필요 |
| `search()` / `vsearch()` | ❌ 사용 안 함 | node-llama-cpp 네이티브 모듈, Electrobun 미보장 |
| `embed()` | ❌ 사용 안 함 | 동일 이유 |
| SQLite 바인딩 | ⚠️ 테스트 필요 | qmd가 better-sqlite3 쓰면 Bun 내장 SQLite와 충돌 가능 |

## ScholarPen KB 검색 전략 — 확정

**embedding 사용 안 함** (사용자 결정).  
**qmd 사용 안 함** — 복잡도 대비 필요 기능이 `searchLex()`뿐이라 과도함.

**확정**: `bun:sqlite` FTS5 직접 사용.
- 추가 패키지 없음, Electrobun 100% 호환 보장
- SQLite FTS5 BM25 랭킹 네이티브 지원
- KB가 영어 논문 위주 → porter ascii 토크나이저로 충분
- 인덱스: `knowledge-base/.kb-index.sqlite`

검색 대상: `summaries/`, `wiki/concepts/`, `wiki/reports/`.  
구현 위치: `src/bun/kb/search.ts` (`KBSearchEngine` 클래스).

## KB의 ScholarPen 역할

KB 구축·관리는 **별도 앱(scholarwiki)**이 담당. ScholarPen은 읽기 전용.
KB는 에디터/AI 채팅에서 **참고자료 컨텍스트 주입**으로만 활용.
별도 KB 뷰어 UI 불필요.

**Why:** KB 관리 파이프라인(PDF → summary → concept 갱신)은 다른 툴에서 이미 운영 중.
**How to apply:** KB 관련 RPC는 `searchKB()`, `getKBStatus()` 최소 범위만 구현. UI에 KB 브라우저 패널 추가하지 않음.
