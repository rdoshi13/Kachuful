import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { applyCommand, createGame, getPublicView } from "@kachuful/game-engine";
import type { Command, RoomStatePayload } from "@kachuful/shared-types";
import { log } from "./logger.js";
import { createApp } from "./app.js";
import { RoomStore } from "./store.js";

interface JoinEvent {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}

const emitGameError = (socket: Socket, message: string, code = "BAD_REQUEST"): void => {
  socket.emit("game:error", { code, message });
};

const roomPayload = (store: RoomStore, roomCode: string): RoomStatePayload => store.getRoomStatePayload(roomCode);

export const createApiServer = (): {
  store: RoomStore;
  httpServer: HttpServer;
  io: SocketIOServer;
} => {
  const store = new RoomStore();
  const app = createApp(store);
  const httpServer = createHttpServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }
  });

  const broadcastRoomState = (roomCode: string): void => {
    io.to(roomCode).emit("room:state", roomPayload(store, roomCode));
  };

  const broadcastGameState = (roomCode: string): void => {
    const room = store.getRoom(roomCode);
    if (!room?.gameState) {
      return;
    }

    const connectedSocketIds = store.getConnectedSocketIds(roomCode);
    for (const socketId of connectedSocketIds) {
      const identity = store.getIdentityBySocket(socketId);
      if (!identity) {
        continue;
      }
      const view = getPublicView(room.gameState, identity.playerId);
      io.to(socketId).emit("game:state", view);
    }
  };

  const applyAndBroadcast = (roomCode: string, command: Command, socket: Socket): void => {
    const room = store.getRoom(roomCode);
    if (!room?.gameState) {
      emitGameError(socket, "Game has not started", "NO_ACTIVE_GAME");
      return;
    }

    const result = applyCommand(room.gameState, command);
    if (!result.ok) {
      emitGameError(socket, result.error.message, result.error.code);
      log("warn", "Command rejected", {
        roomCode,
        playerId: command.actorId,
        command: command.type,
        code: result.error.code
      });
      return;
    }

    store.setGameState(roomCode, result.state);
    broadcastGameState(roomCode);
  };

  io.on("connection", (socket) => {
    socket.on("room:join", (payload: JoinEvent) => {
      try {
        const roomCode = payload.roomCode.toUpperCase();
        const { room, player, reconnected } = store.authenticatePlayer(
          roomCode,
          payload.playerId,
          payload.sessionToken
        );

        store.markConnected(room.roomCode, player.playerId, socket.id);
        socket.join(room.roomCode);

        socket.emit("room:state", roomPayload(store, room.roomCode));
        broadcastRoomState(room.roomCode);

        if (room.gameState) {
          socket.emit("game:state", getPublicView(room.gameState, player.playerId));
        }

        if (reconnected) {
          io.to(room.roomCode).emit("player:reconnected", { playerId: player.playerId, roomCode: room.roomCode });
        }

        log("info", "Player joined room socket", {
          roomCode: room.roomCode,
          playerId: player.playerId,
          reconnected
        });
      } catch (error) {
        emitGameError(socket, (error as Error).message, "AUTH_FAILED");
      }
    });

    socket.on("game:start", () => {
      const identity = store.getIdentityBySocket(socket.id);
      if (!identity) {
        emitGameError(socket, "Join room first", "NOT_JOINED");
        return;
      }

      const room = store.getRoom(identity.roomCode);
      if (!room) {
        emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
        return;
      }
      if (room.gameState) {
        emitGameError(socket, "Game already started", "ALREADY_STARTED");
        return;
      }
      if (room.hostPlayerId !== identity.playerId) {
        emitGameError(socket, "Only host can start game", "FORBIDDEN");
        return;
      }
      if (room.players.length < 2) {
        emitGameError(socket, "At least 2 players required", "MIN_PLAYERS");
        return;
      }

      const game = createGame({
        gameId: room.roomCode,
        players: room.players.map((player) => ({ playerId: player.playerId, name: player.name }))
      });
      const started = applyCommand(game, {
        type: "start_game",
        actorId: identity.playerId
      });

      if (!started.ok) {
        emitGameError(socket, started.error.message, started.error.code);
        return;
      }

      store.setGameState(room.roomCode, started.state);
      store.lockRoom(room.roomCode);
      broadcastRoomState(room.roomCode);
      broadcastGameState(room.roomCode);
    });

    socket.on("bid:submit", (payload: { bid: number }) => {
      const identity = store.getIdentityBySocket(socket.id);
      if (!identity) {
        emitGameError(socket, "Join room first", "NOT_JOINED");
        return;
      }
      applyAndBroadcast(identity.roomCode, {
        type: "submit_bid",
        actorId: identity.playerId,
        bid: payload.bid
      }, socket);
    });

    socket.on("card:play", (payload: { cardId: string }) => {
      const identity = store.getIdentityBySocket(socket.id);
      if (!identity) {
        emitGameError(socket, "Join room first", "NOT_JOINED");
        return;
      }
      applyAndBroadcast(identity.roomCode, {
        type: "play_card",
        actorId: identity.playerId,
        cardId: payload.cardId
      }, socket);
    });

    socket.on("state:sync_request", () => {
      const identity = store.getIdentityBySocket(socket.id);
      if (!identity) {
        emitGameError(socket, "Join room first", "NOT_JOINED");
        return;
      }
      const room = store.getRoom(identity.roomCode);
      if (!room) {
        emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
        return;
      }

      socket.emit("room:state", roomPayload(store, room.roomCode));
      if (room.gameState) {
        socket.emit("game:state", getPublicView(room.gameState, identity.playerId));
      }
    });

    socket.on("disconnect", () => {
      const disconnected = store.markDisconnected(socket.id);
      if (!disconnected) {
        return;
      }
      broadcastRoomState(disconnected.room.roomCode);
      log("info", "Player disconnected", {
        roomCode: disconnected.room.roomCode,
        playerId: disconnected.player.playerId
      });
    });
  });

  return { store, httpServer, io };
};
