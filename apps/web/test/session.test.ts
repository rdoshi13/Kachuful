import { describe, expect, it } from "vitest";
import { clearSession, loadSession, saveSession, type StoredSession } from "../lib/session";

describe("session storage", () => {
  it("saves and loads session payload", () => {
    const session: StoredSession = {
      roomCode: "ABC123",
      playerId: "p1",
      sessionToken: "token",
      name: "Host"
    };

    saveSession(session);
    expect(loadSession()).toEqual(session);

    clearSession();
    expect(loadSession()).toBeNull();
  });
});
