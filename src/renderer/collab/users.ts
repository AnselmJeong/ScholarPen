import type { User } from "@blocknote/core/comments";
import { AI_USER_ID, LOCAL_USER_ID } from "../../shared/collab/threads";

function avatar(label: string, background: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${background}"/>` +
    `<text x="32" y="41" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const AI_COLOR = "#7c3aed";
export const LOCAL_COLOR = "#2563eb";

export const COLLAB_USERS: Record<string, User> = {
  [LOCAL_USER_ID]: { id: LOCAL_USER_ID, username: "You", avatarUrl: avatar("Y", LOCAL_COLOR) },
  [AI_USER_ID]: { id: AI_USER_ID, username: "ScholarPen AI", avatarUrl: avatar("AI", AI_COLOR) },
};

export async function resolveCollabUsers(userIds: string[]): Promise<User[]> {
  return userIds.map((id) => COLLAB_USERS[id] ?? { id, username: id, avatarUrl: avatar("?", "#6b7280") });
}
