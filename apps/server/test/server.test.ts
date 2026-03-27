import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { io as createClient, type Socket } from "socket.io-client";
import type { PublicGameView, RoomJoinResponse, RoomStatePayload } from "@kachuful/shared-types";
import { createApiServer } from "../src/socket.js";

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

  beforeEach(async () => {
    const { httpServer } = createApiServer();
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
});
