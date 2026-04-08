---
name: BlockNote 파일 포맷 및 Export
description: ScholarPen에서 BlockNote 문서가 저장되는 JSON 포맷, Markdown/HTML export 방법, 커스텀 블록의 변환 손실 주의사항
type: project
---

## 저장 포맷

`editor.document`를 그대로 `manuscript.scholarpen.json`에 저장. BlockNote 독자 JSON 포맷.

```json
[
  {
    "id": "abc123",
    "type": "heading",
    "props": { "level": 1 },
    "content": [{ "type": "text", "text": "Title", "styles": {} }],
    "children": []
  }
]
```

저장 코드 (`EditorArea.tsx`): `rpc.saveManuscript(project.path, editor.document)`

## Export API

```typescript
// Markdown (lossy)
const md = await editor.blocksToMarkdownLossy(editor.document);

// Full HTML (손실 없음)
const html = await editor.blocksToFullHTML(editor.document);

// Markdown → blocks (import)
const blocks = await editor.tryParseMarkdownToBlocks(mdString);
```

## 커스텀 블록 변환 손실

`blocksToMarkdownLossy`는 ScholarPen 커스텀 블록(math, figure, abstract, citation inline)을 표준 Markdown으로 변환 불가 → 손실.
표준 블록(paragraph, heading, bold, italic, list 등)은 완벽 변환.

**Why:** 표준 Markdown에 대응 문법이 없는 블록 타입은 드롭됨.
**How to apply:** Phase 5 Export 구현 시 커스텀 블록별 변환 규칙을 별도 정의해야 함.
- math → `$$...$$`
- citation → `[@citekey]`
- figure → `![caption](url)`
- abstract → 일반 paragraph로 폴백
