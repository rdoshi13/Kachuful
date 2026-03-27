import type { RoomJoinResponse } from "@kachuful/shared-types";

export interface StoredSession extends RoomJoinResponse {
  name: string;
}

const SESSION_KEY = "kachuful:session";

export const saveSession = (session: StoredSession): void => {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
};

export const loadSession = (): StoredSession | null => {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
};

export const clearSession = (): void => {
  localStorage.removeItem(SESSION_KEY);
};
