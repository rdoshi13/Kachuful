import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/store.js";

describe("RoomStore join behavior", () => {
  it("reuses offline seat for same-name rejoin", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");
    const firstJoin = store.joinRoom(created.room.roomCode, "Guest");

    const secondJoin = store.joinRoom(created.room.roomCode, "Guest");

    const room = store.getRoom(created.room.roomCode);
    expect(secondJoin.response.playerId).toBe(firstJoin.response.playerId);
    expect(secondJoin.response.sessionToken).not.toBe(firstJoin.response.sessionToken);
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

  it("allows same-name offline seat reclaim even when room is locked", () => {
    const store = new RoomStore();
    const created = store.createRoom("Host");
    const guest = store.joinRoom(created.room.roomCode, "Guest");

    store.setRoomLocked(created.room.roomCode, true);

    const reclaimed = store.joinRoom(created.room.roomCode, "Guest");
    expect(reclaimed.response.playerId).toBe(guest.response.playerId);
    expect(reclaimed.response.sessionToken).not.toBe(guest.response.sessionToken);
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

  it("blocks non-host socket auth while host is offline", () => {
    const store = new RoomStore();
    const host = store.createRoom("Host");
    store.markConnected(host.room.roomCode, host.response.playerId, "host-socket");

    const guest = store.joinRoom(host.room.roomCode, "Guest");
    store.markConnected(host.room.roomCode, guest.response.playerId, "guest-socket");

    // Host goes offline.
    store.markDisconnected("host-socket");

    expect(() =>
      store.authenticatePlayer(
        host.room.roomCode,
        guest.response.playerId,
        guest.response.sessionToken
      )
    ).toThrow("Host is offline");
  });

  it("allows host socket auth even when host is offline before reconnect", () => {
    const store = new RoomStore();
    const host = store.createRoom("Host");

    expect(() =>
      store.authenticatePlayer(
        host.room.roomCode,
        host.response.playerId,
        host.response.sessionToken
      )
    ).not.toThrow();
  });

  it("creates one-time transfer code and redeems same seat with new session token", () => {
    const store = new RoomStore();
    const host = store.createRoom("Host");
    const guest = store.joinRoom(host.room.roomCode, "Guest");
    store.markConnected(host.room.roomCode, host.response.playerId, "host-socket");

    const transfer = store.createTransferCode(host.room.roomCode, guest.response.playerId, 60_000, 1_000);
    const consumed = store.consumeTransferCode(host.room.roomCode, transfer.transferCode, 1_500);

    expect(consumed.response.playerId).toBe(guest.response.playerId);
    expect(consumed.response.sessionToken).not.toBe(guest.response.sessionToken);
    expect(consumed.response.name).toBe("Guest");
    expect(() => store.consumeTransferCode(host.room.roomCode, transfer.transferCode, 1_600)).toThrow(
      "Invalid transfer code"
    );
  });

  it("rejects expired transfer code redemption", () => {
    const store = new RoomStore();
    const host = store.createRoom("Host");

    const transfer = store.createTransferCode(host.room.roomCode, host.response.playerId, 500, 100);

    expect(() => store.consumeTransferCode(host.room.roomCode, transfer.transferCode, 700)).toThrow(
      "Transfer code expired"
    );
  });
});
