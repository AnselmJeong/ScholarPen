import React, { useEffect, useState } from "react";
import { rpc } from "../../rpc";
import { resolveMarkdownImage } from "../../utils/markdown-image";

export function MarkdownImage({ src, alt, title, documentPath }: {
  src?: string; alt?: string; title?: string; documentPath: string;
}) {
  const local = resolveMarkdownImage(src ?? "", documentPath);
  const [loaded, setLoaded] = useState<{ path: string; url: string } | null>(null);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    rpc.readBinaryFile(local.path).then((base64) => {
      if (!cancelled) setLoaded({ path: local.path, url: `data:${local.mime};base64,${base64}` });
    }).catch(() => { if (!cancelled) setFailedPath(local.path); });
    return () => { cancelled = true; };
  }, [local?.path, local?.mime]);

  if (local && loaded?.path !== local.path) {
    return <span className="block rounded border border-border px-3 py-2 text-sm text-muted-foreground" role="status">
      {failedPath === local.path ? `이미지를 불러올 수 없습니다: ${src}` : `이미지 불러오는 중: ${alt || src}`}
    </span>;
  }
  return <img src={local ? loaded?.url : src} alt={alt ?? ""} title={title} loading="lazy" />;
}
