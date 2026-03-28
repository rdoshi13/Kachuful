import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/store.js";

describe("RoomStore join behavior", () => {
  it("reuses offline seat for same-name rejoin", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");
    const firstJoin = store.joinRoom(created.room.roomCode, "Guest");
    const secondJoin = store.joinRoom(created.room.roomCode, "Guest");

    expect(secondJoin.response.playerId).toBe(firstJoin.response.playerId);
    expect(secondJoin.response.sessionToken).not.toBe(firstJoin.response.sessionToken);

    const room = store.getRoom(created.room.roomCode);
    expect(room?.players.map((player) => player.name)).toEqual(["Host", "Guest"]);
  });

  it("rejects same-name join when existing player is online", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");
    const guest = store.joinRoom(created.room.roomCode, "Guest");

    store.markConnected(created.room.roomCode, guest.response.playerId, "socket-1");

    expect(() => store.joinRoom(created.room.roomCode, "Guest")).toThrow(
      "Name is already in use"
    );
  });
});
