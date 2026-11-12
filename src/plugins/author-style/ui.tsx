import { PersonalProfilesPanel } from "./ui/PersonalProfilesPanel";
import React, { useEffect, useState } from "react";
import { selectStyleProfile } from "./main/profile-resolver";
import { detectStyleLanguage } from "../../shared/author-style";
import { acceptedText } from "../../renderer/extensions/document-snapshot";
import { AuthorLearningPanel, useStyleView } from "./ui/AuthorLearningPanel";
import type { ExtensionUIProps } from "../../renderer/extensions/slots";
import { styleCommand } from "./client";
function Status({ path, workspace }: { path: string; workspace: ExtensionUIProps["workspace"] }) {
  const { view } = useStyleView(path);
  const [language, setLanguage] = useState<string | undefined>();
  useEffect(() => {
    const editor = workspace.editor; if (!editor) { setLanguage(undefined); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { const state = editor.prosemirrorView?.state; if (state) setLanguage(detectStyleLanguage(acceptedText(state.doc))); }, 150); };
    refresh(); const stop = editor.onChange(refresh); return () => { clearTimeout(timer); stop(); };
  }, [workspace.editor]);
  const resolved = view ? selectStyleProfile(view, { purpose: "rewrite", language }, view.personal) : undefined;
  const profile = resolved?.profile;
  if (!view) return null;
  if (!profile) return view.activeProfileId || view.personalProfileId || view.personal?.defaultProfileId || view.personal?.defaults.length
    ? <span className="text-xs text-muted-foreground" title={resolved?.reason}>문체: 적용 안 됨 · 언어·장르와 프로필 확인</span> : null;
  return <span className="flex items-center gap-2"><button className="text-xs text-muted-foreground" title="클릭하여 문체 적용을 켜거나 끕니다" onClick={() => void styleCommand({ projectPath: path, operation: "configure", expectedRevision: view.revision,
    payload: { ...view.config, strength: view.config.strength === "off" ? "normal" : "off" } }).catch(() => {})}>문체: {profile.name} · {{ off: "끄기", light: "약하게", normal: "보통", strong: "강하게" }[view.config.strength]}</button><button className="text-xs text-muted-foreground" onClick={() => void styleCommand({ projectPath: path, operation: "configure", expectedRevision: view.revision, payload: { ...view.config, skipNext: !view.config.skipNext } }).catch(() => {})}>{view.config.skipNext ? "다음 요청 끄기 예약됨" : "다음 요청만 끄기"}</button></span>;
}
export default function PluginUI({ slot, workspace, projectPath }: ExtensionUIProps) {
  const path = projectPath ?? workspace.editingProject?.path ?? workspace.project?.path ?? "";
  if (slot === "status") return <Status path={path} workspace={workspace} />;
  return <>{slot === "settings" && <PersonalProfilesPanel />}<AuthorLearningPanel key={path} projectPath={path} /></>;
}
