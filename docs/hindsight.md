# Project memory (Hindsight)

ScholarPen connects to `https://hindsight.ecoplay.cloud` through its Control Plane
API. This hosted address is the production default; no local Hindsight server is
required. Opening a project in the app starts background bank provisioning and sync.
The bank ID is stored in `.scholarpen/hindsight.json` inside that project, so reopening
or moving the folder keeps its memory. Existing projects are connected when opened;
copying a project including this file intentionally shares the same bank.

In the AI sidebar, expand **프로젝트 기억** to write a note, import selected document
text, add its source, save, or search memories. Explicitly saved notes, observed author
edits, accepted/rejected AI revision evidence, and supported editing preferences are
sent to the project's bank. Entire manuscripts and conversations are not uploaded
automatically. Relevant memories
are recalled for AI sidebar requests across providers and listed as `[M1]`, `[M2]`, etc.
They are historical reference material, not verified citations, and current documents
and user instructions take precedence.

The **Project** tab shows learned editing preferences with their supporting observations.
A preference needs evidence from at least three distinct paragraphs and three independent
author actions, including a direct edit or explicit author request. Mistaken interpretations
can be excluded from future learning. Pending or directly applied AI edits are not evidence
of author preference. Learned guidance also reaches inline edits, section drafting, and
whole-document editing without overriding the current request or scientific accuracy.

Automatic sync stores operation receipts in `.scholarpen/hindsight-sync.json`, resumes
pending operations after relaunch, and reuses deterministic source IDs on retry. Tests
disable the production client and use isolated loopback services.

Saving uses Hindsight's asynchronous retain API. The UI distinguishes accepted requests
from completed processing and preserves drafts/pending operation IDs locally across
project switches and restarts. Identical notes with the same source reuse a document ID
when retried. Connection failures leave document editing available; a failed recall is
reported in the AI response. Reopen the project or use **연결 재시도** to retry provisioning.

Optional Bun-process environment variables: `SCHOLARPEN_HINDSIGHT_URL` overrides the
Control Plane base URL; `SCHOLARPEN_HINDSIGHT_API_KEY` adds Bearer authentication.
The configured URL must expose the Control Plane `/api` routes (not only dataplane
`/v1/default` routes). Credentials are never written into project metadata.
