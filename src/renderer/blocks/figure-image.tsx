import React, { createContext, useContext, useEffect, useState } from "react";
import { onProjectUpdated, rpc } from "../rpc";
import { subscribeFigureReload } from "./figure-reload";
import { resolveMarkdownImage } from "../utils/markdown-image";

export const FigureDocumentContext = createContext({ projectPath: "", documentPath: "" });

type ImageState =
  | { status: "loading"; identity: string }
  | { status: "ready"; identity: string; src: string }
  | { status: "error"; identity: string };

export interface FigureImageProps {
  sourcePath: string;
  url: string;
  alt: string;
  style?: React.CSSProperties;
  editor?: object;
  blockId?: string;
  reloadToken?: number;
  inProperties?: boolean;
  children?: React.ReactNode;
}

export function FigureImage({ sourcePath, url, alt, style, editor, blockId, reloadToken = 0, inProperties = false, children }: FigureImageProps) {
  const { projectPath, documentPath } = useContext(FigureDocumentContext);
  const localUrl = !sourcePath && resolveMarkdownImage(url, documentPath);
  const localPath = sourcePath || (localUrl && localUrl.path.startsWith(projectPath + "/")
    ? localUrl.path.slice(projectPath.length + 1) : "");
  const identity = JSON.stringify([projectPath, documentPath, sourcePath, url]);
  const [state, setState] = useState<ImageState>({ status: "loading", identity });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!editor || !blockId) return;
    return subscribeFigureReload(editor, blockId, () => setRevision((value) => value + 1));
  }, [editor, blockId]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", identity });
    const load = async () => {
      if (localPath) return rpc.readFigure(projectPath, localPath);
      if (sourcePath || localUrl) throw new Error("Image is outside this project.");
      if (/^data:image\//i.test(url)) return url;
      if (/^https?:\/\//i.test(url)) {
        const remote = new URL(url);
        if (revision || reloadToken) remote.searchParams.set("_scholarpen_reload", String(Date.now()));
        return remote.href;
      }
      throw new Error("No supported image source.");
    };
    load().then((src) => {
      if (!cancelled) setState({ status: "ready", identity, src });
    }).catch(() => {
      if (!cancelled) setState({ status: "error", identity });
    });
    return () => { cancelled = true; };
  }, [identity, localPath, projectPath, revision, reloadToken]);

  useEffect(() => {
    if (!localPath || !projectPath) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 200);
    };
    const unsubscribe = onProjectUpdated((updatedProject, filePath) => {
      if (updatedProject === projectPath && filePath === `${projectPath}/${localPath}`) reload();
    });
    const visible = () => { if (document.visibilityState === "visible") reload(); };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [projectPath, localPath]);

  const hasSource = Boolean(sourcePath || url);
  const current = state.identity === identity ? state : { status: "loading" as const, identity };
  return <div contentEditable={false}>
    {children && <div className="flex justify-end px-2 py-1">{children}</div>}
    {current.status === "ready" ? <img key={`${identity}:${revision}:${reloadToken}`} src={current.src} alt={alt}
      onError={() => setState({ status: "error", identity })}
      className="max-w-full bg-muted/30 object-contain" style={style} /> :
      <div role="status" className="flex min-h-36 items-center justify-center bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        {!hasSource ? (inProperties ? "그림 파일을 선택하세요." : "Properties에서 그림 파일을 연결하세요.") : current.status === "loading" ? "그림을 불러오는 중…" :
          (inProperties ? "그림을 불러올 수 없습니다. 파일을 다시 연결하거나 Reload를 누르세요." : "그림을 불러올 수 없습니다. Properties에서 연결을 확인하세요.")}
      </div>}
  </div>;
}
