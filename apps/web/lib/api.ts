import type { RoomJoinResponse } from "@kachuful/shared-types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000";

const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = (await response.json()) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }
  return payload;
};

export const createRoom = (name: string): Promise<RoomJoinResponse> => postJson("/rooms", { name });

export const joinRoom = (roomCode: string, name: string): Promise<RoomJoinResponse> =>
  postJson(`/rooms/${roomCode.toUpperCase()}/join`, { name });
