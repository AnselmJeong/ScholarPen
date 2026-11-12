import type { PersonalStyleLibrary, StyleProfile, StyleRequest, StyleState } from "../../../shared/author-style";

export function selectStyleProfile(state: StyleState, request: StyleRequest, personal?: PersonalStyleLibrary): { profile?: StyleProfile; scope?: "project" | "personal"; reason?: string } {
  request = { ...request, genre: request.genre ?? state.config.genre ?? "academic" };
  const own = personal?.authorId === state.authorId ? personal : undefined;
  let p: StyleProfile | undefined, scope: "project" | "personal" = "project";
  if (request.profileId) {
    p = state.profiles.find(p => p.id === request.profileId);
    if (!p) { p = own?.profiles.find(p => p.id === request.profileId); scope = "personal"; }
  } else if (state.activeProfileId) p = state.profiles.find(p => p.id === state.activeProfileId);
  else {
    scope = "personal";
    if (state.personalProfileId) p = own?.profiles.find(p => p.id === state.personalProfileId);
    else {
      const binding = own?.defaults.filter(d => (d.language === "any" || d.language === request.language) && (d.genre === "any" || d.genre === request.genre))
        .sort((a, b) => (Number(b.language !== "any") * 2 + Number(b.genre !== "any")) - (Number(a.language !== "any") * 2 + Number(a.genre !== "any")))[0];
      p = own?.profiles.find(p => p.id === (binding?.profileId ?? own.defaultProfileId));
    }
  }
  if (!p) return { reason: "선택한 문체 프로필이 없거나 삭제되었습니다." };
  if ((request.language && p.language !== "any" && p.language !== request.language) || (request.genre && p.genre !== "any" && p.genre !== request.genre))
    return { reason: "선택한 프로필의 언어 또는 장르가 요청과 일치하지 않습니다. 다른 프로필로 대체하지 않았습니다." };
  return { profile: p, scope };
}
