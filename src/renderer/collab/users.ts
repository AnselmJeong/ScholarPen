import type { User } from "@blocknote/core/comments";
import { LOCAL_USER_ID } from "../../shared/collab/threads";
import { SCHOLARPEN_AI, personaByUser } from "../../shared/collab/personas";

function avatar(label: string, background: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${background}"/>` +
    `<text x="32" y="41" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const LOCAL_COLOR = "#2563eb";

export const COLLAB_USERS: Record<string, User> = {
  [LOCAL_USER_ID]: { id: LOCAL_USER_ID, username: "You", avatarUrl: avatar("Y", LOCAL_COLOR) },
  [SCHOLARPEN_AI.userId]: {
    id: SCHOLARPEN_AI.userId,
    username: SCHOLARPEN_AI.name,
    avatarUrl: avatar(SCHOLARPEN_AI.shortName, SCHOLARPEN_AI.color),
  },
};

export async function resolveCollabUsers(userIds: string[]): Promise<User[]> {
  return userIds.map((id) => COLLAB_USERS[id]
    // Comments from the former separate AI reviewers show as ScholarPen AI.
    ?? (personaByUser(id) ? { ...COLLAB_USERS[SCHOLARPEN_AI.userId], id } : { id, username: id, avatarUrl: avatar("?", "#6b7280") }));
}
