import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/store.js";

describe("RoomStore join behavior", () => {
  it("rejects same-name join even when previous seat is offline", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");
    const firstJoin = store.joinRoom(created.room.roomCode, "Guest");

    expect(() => store.joinRoom(created.room.roomCode, "Guest")).toThrow(
      "Name is already in use"
    );

    const room = store.getRoom(created.room.roomCode);
    expect(room?.players.map((player) => player.name)).toEqual(["Host", "Guest"]);
    expect(room?.players.filter((player) => player.playerId === firstJoin.response.playerId)).toHaveLength(1);
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

  it("rejects same-name join even when room is locked", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");
    store.joinRoom(created.room.roomCode, "Guest");

    store.setRoomLocked(created.room.roomCode, true);

    expect(() => store.joinRoom(created.room.roomCode, "Guest")).toThrow(
      "Name is already in use"
    );
  });

  it("rejects new-player join when room is locked", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");
    store.setRoomLocked(created.room.roomCode, true);

    expect(() => store.joinRoom(created.room.roomCode, "Guest")).toThrow(
      "Room is locked"
    );
  });

  it("prunes room after inactivity threshold when everyone is disconnected", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");

    // Host opens a socket session and then disconnects.
    store.markConnected(created.room.roomCode, created.response.playerId, "socket-1");
    store.markDisconnected("socket-1");

    const notYetRemoved = store.pruneInactiveRooms(5_000, Date.now() + 2_000);
    expect(notYetRemoved).toEqual([]);
    expect(store.getRoom(created.room.roomCode)).not.toBeNull();

    const removed = store.pruneInactiveRooms(5_000, Date.now() + 6_000);
    expect(removed).toEqual([created.room.roomCode]);
    expect(store.getRoom(created.room.roomCode)).toBeNull();
  });

  it("does not prune room while at least one player is connected", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");

    store.markConnected(created.room.roomCode, created.response.playerId, "socket-1");
    const removed = store.pruneInactiveRooms(1, Date.now() + 60_000);

    expect(removed).toEqual([]);
    expect(store.getRoom(created.room.roomCode)).not.toBeNull();
  });
});
