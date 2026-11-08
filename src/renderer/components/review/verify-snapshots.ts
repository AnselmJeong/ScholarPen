import { blocksToYDoc, yDocToBlocks } from "@blocknote/core/yjs";
import { getHeadlessEditor, normalizeDocumentContent, openCollabPeer } from "../../collab/collab-peer";
import { manuscriptFingerprint } from "../../../shared/collab/content-fingerprint";
import { COLLAB_FRAGMENT } from "../../../shared/collab/protocol";
import { rpc } from "../../rpc";

/** Compare every selected document, including closed tabs, without replacing its contents. */
export async function verifyReviewSnapshots(projectPath: string, filenames: string[]) {
  const editor = getHeadlessEditor();
  for (const filename of filenames) {
    const peer = await openCollabPeer(projectPath, filename);
    try {
      await peer.afterPushes(async () => {
        const savedDocument = await rpc.loadDocument(projectPath, filename);
        if (peer.bootstrap === "reconcile") throw new Error(`${filename}: 외부에서 원고 파일이 변경됐습니다. 이 원고를 열어 최신 내용을 확인한 뒤 다시 시작해 주세요.`);
        if (/<(?:insertion|deletion|modification)(?:\s|>)/.test(peer.ydoc.getXmlFragment(COLLAB_FRAGMENT).toString())) throw new Error(`${filename}: 아직 승인하지 않은 수정 제안이 있습니다. 원고에서 수락 또는 거절해 주세요.`);
        // Round-trip both sides through the same schema to compare default props and text segments.
        const currentBlocks = yDocToBlocks(editor, peer.ydoc, COLLAB_FRAGMENT);
        const savedBlocks = normalizeDocumentContent(savedDocument);
        // A newly created [] file receives an empty paragraph ID only when opened.
        if (Array.isArray(savedDocument) && savedDocument.length === 0 && currentBlocks.length === 1) {
          (savedBlocks[0] as { id?: string }).id = currentBlocks[0]!.id;
        }
        const saved = blocksToYDoc(editor, savedBlocks as any, COLLAB_FRAGMENT);
        const current = blocksToYDoc(editor, currentBlocks, COLLAB_FRAGMENT);
        try {
          if (manuscriptFingerprint(saved) !== manuscriptFingerprint(current)) throw new Error(`${filename}: 편집 내용과 저장 파일이 다릅니다. 이 원고를 열어 저장한 뒤 다시 시작해 주세요.`);
          await rpc.reviewConfirmSnapshot({ projectPath, filename, savedDocument, fingerprint: manuscriptFingerprint(peer.ydoc) });
        } finally { saved.destroy(); current.destroy(); }
      });
    } finally { peer.destroy(); }
  }
}
