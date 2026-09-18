import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { onProjectUpdated, rpc } from "../rpc";
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
  onSourceChange: (source: { sourcePath: string; url: string }) => void;
  children?: React.ReactNode;
}

export function FigureImage({ sourcePath, url, alt, style, onSourceChange, children }: FigureImageProps) {
  const { projectPath, documentPath } = useContext(FigureDocumentContext);
  const localUrl = !sourcePath && resolveMarkdownImage(url, documentPath);
  const localPath = sourcePath || (localUrl && localUrl.path.startsWith(projectPath + "/")
    ? localUrl.path.slice(projectPath.length + 1) : "");
  const identity = JSON.stringify([projectPath, documentPath, sourcePath, url]);
  const [state, setState] = useState<ImageState>({ status: "loading", identity });
  const [revision, setRevision] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [editingUrl, setEditingUrl] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const selectionGeneration = useRef(0);

  useEffect(() => {
    selectionGeneration.current++;
    setSelecting(false);
    setNotice("");
    setEditingUrl(false);
    return () => { selectionGeneration.current++; };
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", identity });
    const load = async () => {
      if (localPath) return rpc.readFigure(projectPath, localPath);
      if (sourcePath || localUrl) throw new Error("Image is outside this project.");
      if (/^data:image\//i.test(url)) return url;
      if (/^https?:\/\//i.test(url)) {
        const remote = new URL(url);
        if (revision) remote.searchParams.set("_scholarpen_reload", String(Date.now()));
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
  }, [identity, localPath, projectPath, revision]);

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

  const chooseFile = async () => {
    const generation = selectionGeneration.current;
    const stillCurrent = () => generation === selectionGeneration.current && activeIdentity.current === identity;
    setSelecting(true);
    setNotice("");
    try {
      const selected = await rpc.selectFigure(projectPath);
      if (!stillCurrent() || !selected) return;
      onSourceChange({ sourcePath: selected.sourcePath, url: "" });
      // Selecting the same path must still re-read its latest bytes.
      setRevision((value) => value + 1);
      setNotice(selected.copied ? "프로젝트에 복사했습니다. 이후에는 프로젝트 안의 그림 파일을 수정하세요." : "");
    } catch (error) {
      if (stillCurrent()) setNotice(error instanceof Error ? error.message : "그림을 연결하지 못했습니다.");
    } finally {
      if (stillCurrent()) setSelecting(false);
    }
  };

  const hasSource = Boolean(sourcePath || url);
  const current = state.identity === identity ? state : { status: "loading" as const, identity };
  const buttonClass = "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50";
  return <div contentEditable={false}>
    <div className="flex flex-wrap items-center justify-end gap-1 border-b border-border px-2 py-1">
      <button type="button" className={buttonClass} disabled={!projectPath || selecting} onClick={chooseFile}>
        {selecting ? "파일 선택 중…" : hasSource ? "다시 연결" : "그림 연결"}
      </button>
      <button type="button" className={buttonClass} disabled={!hasSource} title="연결된 그림만 다시 불러오기"
        onClick={() => { setNotice(""); setRevision((value) => value + 1); }}>Reload</button>
      <button type="button" className={buttonClass} onClick={() => {
        setUrlDraft(/^https?:/i.test(url) ? url : ""); setEditingUrl((value) => !value);
      }}>URL</button>
      {children}
    </div>
    {editingUrl && <form className="flex gap-2 border-b border-border p-2" onSubmit={(event) => {
      event.preventDefault();
      if (!/^https?:\/\//i.test(urlDraft.trim())) { setNotice("http 또는 https 이미지 주소를 입력하세요."); return; }
      onSourceChange({ sourcePath: "", url: urlDraft.trim() });
      setEditingUrl(false);
    }}>
      <input autoFocus aria-label="이미지 URL" className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-sm"
        value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} placeholder="https://…"
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") setEditingUrl(false); }} />
      <button type="submit" className={buttonClass}>연결</button>
    </form>}
    {current.status === "ready" ? <img key={`${identity}:${revision}`} src={current.src} alt={alt}
      onError={() => setState({ status: "error", identity })}
      className="max-w-full bg-muted/30 object-contain" style={style} /> :
      <div role="status" className="flex min-h-36 items-center justify-center bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
        {!hasSource ? "그림 연결을 눌러 파일을 선택하세요." : current.status === "loading" ? "그림을 불러오는 중…" :
          "그림을 불러올 수 없습니다. 다시 연결로 파일을 선택하거나, 파일을 복구한 뒤 Reload를 누르세요."}
      </div>}
    {hasSource && <div className="break-all px-3 py-1 text-xs text-muted-foreground" title={sourcePath || (url.startsWith("data:") ? "" : url)}>
      {sourcePath || (url.startsWith("data:") ? "문서에 포함된 그림 · 원본 파일을 연결하려면 다시 연결을 누르세요." : url)}
    </div>}
    {sourcePath && <p className="px-3 pb-1 text-xs text-muted-foreground">프로젝트 안의 이 파일을 수정하면 반영됩니다.</p>}
    {notice && <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
  </div>;
}
