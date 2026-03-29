import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { io as createClient, type Socket } from "socket.io-client";
import type { PublicGameView, RoomJoinResponse, RoomStatePayload } from "@kachuful/shared-types";
import { createGame } from "@kachuful/game-engine";
import { createApiServer } from "../src/socket.js";
import { MatchHistoryStore } from "../src/history-store.js";

const waitForEvent = <T>(socket: Socket, event: string, timeoutMs = 2000): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for event: ${event}`));
    }, timeoutMs);

    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

const waitForConnect = (socket: Socket): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket connect timeout")), 2000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
  });

describe("server integration", () => {
  let baseUrl = "";
  let sockets: Socket[] = [];
  let closeServer: (() => Promise<void>) | null = null;
  let store: ReturnType<typeof createApiServer>["store"];
  let historyTempDir = "";
  let historyFilePath = "";

  beforeEach(async () => {
    historyTempDir = mkdtempSync(path.join(os.tmpdir(), "kachuful-history-"));
    historyFilePath = path.join(historyTempDir, "history.json");
    const server = createApiServer({
      historyStore: new MatchHistoryStore({ filePath: historyFilePath })
    });
    const { httpServer } = server;
    store = server.store;
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine test server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    closeServer = async () => {
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (!socket.connected) {
                resolve();
                return;
              }
              socket.once("disconnect", () => resolve());
              socket.disconnect();
            })
        )
      );
      sockets = [];

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    };
  });

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
    }
    if (historyTempDir) {
      rmSync(historyTempDir, { recursive: true, force: true });
    }
  });

  it("supports HTTP room create/join lifecycle", async () => {
    const createResponse = await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201);
    const created = createResponse.body as RoomJoinResponse;

    expect(created.roomCode).toHaveLength(6);
    expect(created.playerId).toBeTruthy();
    expect(created.sessionToken).toBeTruthy();

    const joinResponse = await request(baseUrl)
      .post(`/rooms/${created.roomCode}/join`)
      .send({ name: "Guest" })
      .expect(200);

    const joined = joinResponse.body as RoomJoinResponse;
    expect(joined.roomCode).toBe(created.roomCode);
    expect(joined.playerId).not.toBe(created.playerId);
  });

  it("reuses offline seat when rejoining with the same name", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const firstGuest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const secondGuest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    expect(secondGuest.playerId).toBe(firstGuest.playerId);
    expect(secondGuest.sessionToken).not.toBe(firstGuest.sessionToken);

    const room = store.getRoom(host.roomCode);
    expect(room?.players.map((player) => player.name)).toEqual(["Host", "Guest"]);
  });

  it("allows HTTP rejoin for same-name offline player in locked room", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("game:start");
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    await new Promise<void>((resolve) => {
      guestSocket.once("disconnect", () => resolve());
      guestSocket.disconnect();
    });

    const rejoin = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    expect(rejoin.playerId).toBe(guest.playerId);
    expect(rejoin.sessionToken).not.toBe(guest.sessionToken);
  });

  it("lets host toggle room lock and rejects non-host toggles", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("room:lock_toggle", { locked: true });
    const [hostLockedState, guestLockedState] = await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);
    expect(hostLockedState.locked).toBe(true);
    expect(guestLockedState.locked).toBe(true);

    guestSocket.emit("room:lock_toggle", { locked: false });
    const gameError = await waitForEvent<{ code: string; message: string }>(guestSocket, "game:error");
    expect(gameError.code).toBe("FORBIDDEN");
  });

  it("adds new joiners as spectators during active match and includes them next game", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("game:start");
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    const spectator = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Spectator" })
        .expect(200)
    ).body as RoomJoinResponse;

    const spectatorSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(spectatorSocket);
    await waitForConnect(spectatorSocket);
    const spectatorRoomStatePromise = waitForEvent<RoomStatePayload>(spectatorSocket, "room:state");
    const spectatorGameViewPromise = waitForEvent<PublicGameView>(spectatorSocket, "game:state");
    spectatorSocket.emit("room:join", spectator);

    const spectatorRoomState = await spectatorRoomStatePromise;
    const spectatorGameView = await spectatorGameViewPromise;
    expect(spectatorRoomState.players.map((player) => player.name)).toEqual(["Host", "Guest", "Spectator"]);
    expect(spectatorGameView.players.map((player) => player.name)).toEqual(["Host", "Guest"]);

    const hostEndedGameViewPromise = waitForEvent<PublicGameView>(hostSocket, "game:state");
    const guestEndedGameViewPromise = waitForEvent<PublicGameView>(guestSocket, "game:state");
    const spectatorEndedGameViewPromise = waitForEvent<PublicGameView>(spectatorSocket, "game:state");
    hostSocket.emit("game:end");
    await Promise.all([
      hostEndedGameViewPromise,
      guestEndedGameViewPromise,
      spectatorEndedGameViewPromise
    ]);

    const spectatorRestartedViewPromise = waitForEvent<PublicGameView>(spectatorSocket, "game:state");
    hostSocket.emit("game:restart");
    const spectatorRestartedView = await spectatorRestartedViewPromise;
    expect(spectatorRestartedView.phase).toBe("bidding");
    expect(spectatorRestartedView.players.map((player) => player.name)).toEqual([
      "Host",
      "Guest",
      "Spectator"
    ]);
  });

  it("excludes disconnected spectators from the next game on restart", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("game:start");
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    const spectator = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Spectator" })
        .expect(200)
    ).body as RoomJoinResponse;

    const spectatorSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(spectatorSocket);
    await waitForConnect(spectatorSocket);
    spectatorSocket.emit("room:join", spectator);
    await Promise.all([
      waitForEvent<RoomStatePayload>(spectatorSocket, "room:state"),
      waitForEvent<PublicGameView>(spectatorSocket, "game:state")
    ]);

    await new Promise<void>((resolve) => {
      spectatorSocket.once("disconnect", () => resolve());
      spectatorSocket.disconnect();
    });

    await waitForEvent<RoomStatePayload>(hostSocket, "room:state");

    const hostEndedGameViewPromise = waitForEvent<PublicGameView>(hostSocket, "game:state");
    const guestEndedGameViewPromise = waitForEvent<PublicGameView>(guestSocket, "game:state");
    hostSocket.emit("game:end");
    await Promise.all([hostEndedGameViewPromise, guestEndedGameViewPromise]);

    const hostRestartedViewPromise = waitForEvent<PublicGameView>(hostSocket, "game:state");
    hostSocket.emit("game:restart");
    const hostRestartedView = await hostRestartedViewPromise;
    expect(hostRestartedView.phase).toBe("bidding");
    expect(hostRestartedView.players.map((player) => player.name)).toEqual([
      "Host",
      "Guest"
    ]);
  });

  it("rejects joining with an already-online name", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(guestSocket);
    await waitForConnect(guestSocket);
    guestSocket.emit("room:join", guest);
    await waitForEvent<RoomStatePayload>(guestSocket, "room:state");

    const duplicateJoin = await request(baseUrl)
      .post(`/rooms/${host.roomCode}/join`)
      .send({ name: "Guest" })
      .expect(409);

    expect(duplicateJoin.body.error).toContain("already in use");
  });

  it("broadcasts game state and rejects invalid out-of-turn commands", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);

    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);

    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("game:start");

    const [hostGameView, guestGameView] = await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    expect(hostGameView.phase).toBe("bidding");
    expect(guestGameView.phase).toBe("bidding");

    const turnPlayerId = hostGameView.currentRound?.bidTurnPlayerId;
    expect(turnPlayerId).toBeTruthy();

    const wrongSocket = turnPlayerId === host.playerId ? guestSocket : hostSocket;
    wrongSocket.emit("bid:submit", { bid: 0 });

    const gameError = await waitForEvent<{ code: string; message: string }>(wrongSocket, "game:error");
    expect(gameError.code).toBe("OUT_OF_TURN");
  });

  it("supports same-session reconnect without seat duplication", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);

    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);

    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("game:start");
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    await new Promise<void>((resolve) => {
      guestSocket.once("disconnect", () => resolve());
      guestSocket.disconnect();
    });

    const reconnectSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(reconnectSocket);
    await waitForConnect(reconnectSocket);

    const reconnectedEventPromise = waitForEvent<{ playerId: string; roomCode: string }>(hostSocket, "player:reconnected");
    reconnectSocket.emit("room:join", guest);

    const [roomStateAfterReconnect, reconnectGameState, reconnectedEvent] = await Promise.all([
      waitForEvent<RoomStatePayload>(reconnectSocket, "room:state"),
      waitForEvent<PublicGameView>(reconnectSocket, "game:state"),
      reconnectedEventPromise
    ]);

    expect(reconnectedEvent.playerId).toBe(guest.playerId);
    expect(roomStateAfterReconnect.players).toHaveLength(2);
    expect(roomStateAfterReconnect.players.filter((player) => player.playerId === guest.playerId)).toHaveLength(1);
    expect(Array.isArray(reconnectGameState.currentRound?.viewerHand ?? [])).toBe(true);
  });

  it("allows host to restart after game completion", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const room = store.getRoom(host.roomCode);
    expect(room).not.toBeNull();
    if (!room) {
      throw new Error("Expected room to exist");
    }

    const ended = createGame({
      gameId: room.roomCode,
      players: room.players.map((player) => ({ playerId: player.playerId, name: player.name }))
    });
    store.setGameState(room.roomCode, {
      ...ended,
      phase: "game_complete",
      roundNumber: 14,
      currentRound: null
    });

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);

    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);
    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);

    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    hostSocket.emit("game:restart");
    const [hostRestartedState, guestRestartedState] = await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    expect(hostRestartedState.phase).toBe("bidding");
    expect(hostRestartedState.roundNumber).toBe(0);
    expect(guestRestartedState.phase).toBe("bidding");
  });

  it("rejects non-host restart attempts", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const room = store.getRoom(host.roomCode);
    expect(room).not.toBeNull();
    if (!room) {
      throw new Error("Expected room to exist");
    }

    const ended = createGame({
      gameId: room.roomCode,
      players: room.players.map((player) => ({ playerId: player.playerId, name: player.name }))
    });
    store.setGameState(room.roomCode, {
      ...ended,
      phase: "game_complete",
      roundNumber: 14,
      currentRound: null
    });

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    guestSocket.emit("game:restart");
    const gameError = await waitForEvent<{ code: string; message: string }>(guestSocket, "game:error");
    expect(gameError.code).toBe("FORBIDDEN");
  });

  it("allows host to end an active game early", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("game:start");
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    hostSocket.emit("game:end");
    const [hostEndedState, guestEndedState] = await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    expect(hostEndedState.phase).toBe("game_complete");
    expect(hostEndedState.currentRound).toBeNull();
    expect(guestEndedState.phase).toBe("game_complete");
    expect(guestEndedState.currentRound).toBeNull();
  });

  it("rejects non-host end-game attempts", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);

    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<RoomStatePayload>(hostSocket, "room:state"),
      waitForEvent<RoomStatePayload>(guestSocket, "room:state")
    ]);

    hostSocket.emit("game:start");
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    guestSocket.emit("game:end");
    const gameError = await waitForEvent<{ code: string; message: string }>(guestSocket, "game:error");
    expect(gameError.code).toBe("FORBIDDEN");
  });

  it("persists completed match history and reloads it after server restart", async () => {
    const host = (await request(baseUrl).post("/rooms").send({ name: "Host" }).expect(201)).body as RoomJoinResponse;
    const guest = (
      await request(baseUrl)
        .post(`/rooms/${host.roomCode}/join`)
        .send({ name: "Guest" })
        .expect(200)
    ).body as RoomJoinResponse;

    const room = store.getRoom(host.roomCode);
    expect(room).not.toBeNull();
    if (!room) {
      throw new Error("Expected room to exist");
    }

    const ended = createGame({
      gameId: room.roomCode,
      players: room.players.map((player) => ({ playerId: player.playerId, name: player.name }))
    });
    store.setGameState(room.roomCode, {
      ...ended,
      phase: "game_complete",
      roundNumber: 14,
      startedAt: 1,
      updatedAt: 200,
      currentRound: null,
      completedRounds: [{
        roundIndex: 0,
        cardsPerPlayer: 1,
        trumpSuit: "S",
        bids: Object.fromEntries(room.players.map((player) => [player.playerId, 0])),
        tricksWon: Object.fromEntries(room.players.map((player) => [player.playerId, 0])),
        scoreDelta: Object.fromEntries(room.players.map((player) => [player.playerId, 10]))
      }],
      scores: Object.fromEntries(room.players.map((player, index) => [player.playerId, index === 0 ? 10 : 0]))
    });

    const hostSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    const guestSocket = createClient(baseUrl, { transports: ["websocket"], forceNew: true, reconnection: false });
    sockets.push(hostSocket, guestSocket);
    await Promise.all([waitForConnect(hostSocket), waitForConnect(guestSocket)]);
    hostSocket.emit("room:join", host);
    guestSocket.emit("room:join", guest);
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    hostSocket.emit("game:restart");
    await Promise.all([
      waitForEvent<PublicGameView>(hostSocket, "game:state"),
      waitForEvent<PublicGameView>(guestSocket, "game:state")
    ]);

    const historyBeforeRestart = await request(baseUrl).get(`/rooms/${host.roomCode}/history`).expect(200);
    expect(historyBeforeRestart.body.matches).toHaveLength(1);
    expect(historyBeforeRestart.body.matches[0]?.roomCode).toBe(host.roomCode);

    if (closeServer) {
      await closeServer();
      closeServer = null;
    }

    const restartedServer = createApiServer({
      historyStore: new MatchHistoryStore({ filePath: historyFilePath })
    });
    const { httpServer } = restartedServer;
    store = restartedServer.store;
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine test server address after restart");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = async () => {
      await Promise.all(
        sockets.map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (!socket.connected) {
                resolve();
                return;
              }
              socket.once("disconnect", () => resolve());
              socket.disconnect();
            })
        )
      );
      sockets = [];

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    };

    const historyAfterRestart = await request(baseUrl).get(`/rooms/${host.roomCode}/history`).expect(200);
    expect(historyAfterRestart.body.matches).toHaveLength(1);
    expect(historyAfterRestart.body.matches[0]?.winnerPlayerIds).toContain(host.playerId);
  });
});
