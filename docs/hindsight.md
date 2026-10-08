# Project memory (Hindsight)

ScholarPen connects to `https://hindsight.ecoplay.cloud` through its Control Plane
API. Creating or opening a project provisions a dedicated bank in the background.
The bank ID is stored in `.scholarpen/hindsight.json` inside that project, so reopening
or moving the folder keeps its memory. Existing projects are connected when opened;
copying a project including this file intentionally shares the same bank.

In the AI sidebar, expand **프로젝트 기억** to write a note, import selected document
text, add its source, save, or search memories. Only explicitly saved notes are sent;
entire manuscripts and conversations are not uploaded automatically. Relevant memories
are recalled for AI sidebar requests across providers and listed as `[M1]`, `[M2]`, etc.
They are historical reference material, not verified citations, and current documents
and user instructions take precedence.

Saving uses Hindsight's asynchronous retain API. The UI distinguishes accepted requests
from completed processing and preserves drafts/pending operation IDs locally across
project switches and restarts. Identical notes with the same source reuse a document ID
when retried. Connection failures leave document editing available; a failed recall is
reported in the AI response. Reopen the project or use **연결 재시도** to retry provisioning.

Optional Bun-process environment variables: `SCHOLARPEN_HINDSIGHT_URL` overrides the
Control Plane base URL; `SCHOLARPEN_HINDSIGHT_API_KEY` adds Bearer authentication.
The configured URL must expose the Control Plane `/api` routes (not only dataplane
`/v1/default` routes). Credentials are never written into project metadata.
