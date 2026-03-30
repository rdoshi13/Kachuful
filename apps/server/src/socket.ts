import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { applyCommand, createGame, getPublicView } from "@kachuful/game-engine";
import type { Command, RoomStatePayload, TransferSeatRequest } from "@kachuful/shared-types";
import { log } from "./logger.js";
import { createApp } from "./app.js";
import { MatchHistoryStore } from "./history-store.js";
import { RoomStore } from "./store.js";

interface JoinEvent {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}
interface TransferCodePayload {
  transferCode: string;
  expiresAt: number;
}

interface TrickRevealPayload {
  winnerId: string;
  winnerCardId: string;
  trickCount: number;
  roundIndex: number;
  plays: Array<{ playerId: string; cardId: string }>;
}

const emitGameError = (socket: Socket, message: string, code = "BAD_REQUEST"): void => {
  socket.emit("game:error", { code, message });
};

const roomPayload = (store: RoomStore, roomCode: string): RoomStatePayload => store.getRoomStatePayload(roomCode);

const asTrickRevealPayload = (value: unknown): TrickRevealPayload | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Partial<TrickRevealPayload>;
  if (
    typeof payload.winnerId !== "string"
    || typeof payload.winnerCardId !== "string"
    || typeof payload.trickCount !== "number"
    || typeof payload.roundIndex !== "number"
    || !Array.isArray(payload.plays)
  ) {
    return null;
  }

  const plays = payload.plays.filter((play): play is { playerId: string; cardId: string } =>
    Boolean(play)
    && typeof play === "object"
    && typeof (play as { playerId?: unknown }).playerId === "string"
    && typeof (play as { cardId?: unknown }).cardId === "string");

  if (plays.length !== payload.plays.length) {
    return null;
  }

  return {
    winnerId: payload.winnerId,
    winnerCardId: payload.winnerCardId,
    trickCount: payload.trickCount,
    roundIndex: payload.roundIndex,
    plays
  };
};

interface CreateApiServerOptions {
  store?: RoomStore;
  historyStore?: MatchHistoryStore;
}

const ROOM_IDLE_TTL_MS = Number(process.env.ROOM_IDLE_TTL_MS ?? 10 * 60 * 1000);
const ROOM_PRUNE_INTERVAL_MS = Number(process.env.ROOM_PRUNE_INTERVAL_MS ?? 60 * 1000);

export const createApiServer = (options: CreateApiServerOptions = {}): {
  store: RoomStore;
  historyStore: MatchHistoryStore;
  httpServer: HttpServer;
  io: SocketIOServer;
} => {
  const store = options.store ?? new RoomStore();
  const historyStore = options.historyStore ?? new MatchHistoryStore();
  const app = createApp(store, historyStore);
  const httpServer = createHttpServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*" }
  });
  const roomPruneInterval = setInterval(() => {
    const removedRooms = store.pruneInactiveRooms(ROOM_IDLE_TTL_MS);
    if (removedRooms.length > 0) {
      log("info", "Pruned inactive rooms", {
        removedCount: removedRooms.length,
        roomCodes: removedRooms
      });
    }
  }, ROOM_PRUNE_INTERVAL_MS);
  roomPruneInterval.unref();
  httpServer.once("close", () => {
    clearInterval(roomPruneInterval);
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

  const disconnectPlayerSockets = (roomCode: string, playerId: string): void => {
    const socketIds = store.getSocketIdsForPlayer(roomCode, playerId);
    for (const socketId of socketIds) {
      io.sockets.sockets.get(socketId)?.disconnect(true);
    }
  };

  app.post("/rooms/:code/transfer", (req, res) => {
    try {
      const body = req.body as Partial<TransferSeatRequest>;
      if (!body?.transferCode || typeof body.transferCode !== "string") {
        return res.status(400).json({ error: "Transfer code is required" });
      }
      const { room, response } = store.consumeTransferCode(
        req.params.code ?? "",
        body.transferCode
      );
      disconnectPlayerSockets(room.roomCode, response.playerId);
      return res.status(200).json(response);
    } catch (error) {
      const message = (error as Error).message;
      const normalized = message.toLocaleLowerCase();
      if (normalized.includes("not found")) {
        return res.status(404).json({ error: message });
      }
      if (normalized.includes("offline") || normalized.includes("invalid") || normalized.includes("expired")) {
        return res.status(409).json({ error: message });
      }
      return res.status(400).json({ error: message });
    }
  });

  const applyAndBroadcast = (roomCode: string, command: Command, socket: Socket): void => {
    const room = store.getRoom(roomCode);
    if (!room?.gameState) {
      emitGameError(socket, "Game has not started", "NO_ACTIVE_GAME");
      return;
    }
    const wasComplete = room.gameState.phase === "game_complete";

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
    for (const event of result.events) {
      if (event.type !== "trick_complete") {
        continue;
      }
      const payload = asTrickRevealPayload(event.payload);
      if (!payload) {
        continue;
      }
      io.to(roomCode).emit("game:trick_reveal", payload);
    }
    if (!wasComplete && result.state.phase === "game_complete") {
      historyStore.recordCompletedGame(roomCode, result.state);
    }
    broadcastGameState(roomCode);
  };

  const startRoomGame = (roomCode: string, hostPlayerId: string, socket: Socket): void => {
    const room = store.getRoom(roomCode);
    if (!room) {
      emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }
    const activePlayers = room.players.filter((player) => player.connected);
    if (activePlayers.length < 2) {
      emitGameError(socket, "At least 2 active players required", "MIN_PLAYERS");
      return;
    }
    if (room.gameState?.phase === "game_complete") {
      historyStore.recordCompletedGame(roomCode, room.gameState);
    }

    const game = createGame({
      gameId: room.roomCode,
      players: activePlayers.map((player) => ({ playerId: player.playerId, name: player.name }))
    });
    const started = applyCommand(game, {
      type: "start_game",
      actorId: hostPlayerId
    });

    if (!started.ok) {
      emitGameError(socket, started.error.message, started.error.code);
      return;
    }

    store.setGameState(room.roomCode, started.state);
    broadcastRoomState(room.roomCode);
    broadcastGameState(room.roomCode);
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

    socket.on("session:transfer_request", () => {
      const identity = store.getIdentityBySocket(socket.id);
      if (!identity) {
        emitGameError(socket, "Join room first", "NOT_JOINED");
        return;
      }

      try {
        const transfer: TransferCodePayload = store.createTransferCode(
          identity.roomCode,
          identity.playerId
        );
        socket.emit("session:transfer_code", transfer);
      } catch (error) {
        emitGameError(socket, (error as Error).message, "TRANSFER_FAILED");
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
      startRoomGame(room.roomCode, identity.playerId, socket);
    });

    socket.on("room:lock_toggle", (payload?: { locked?: boolean }) => {
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
      if (room.hostPlayerId !== identity.playerId) {
        emitGameError(socket, "Only host can change room lock", "FORBIDDEN");
        return;
      }

      const nextLocked =
        typeof payload?.locked === "boolean" ? payload.locked : !room.locked;
      store.setRoomLocked(room.roomCode, nextLocked);
      broadcastRoomState(room.roomCode);
    });

    socket.on("game:restart", () => {
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
      if (room.hostPlayerId !== identity.playerId) {
        emitGameError(socket, "Only host can restart game", "FORBIDDEN");
        return;
      }
      if (!room.gameState) {
        emitGameError(socket, "No game to restart", "NO_ACTIVE_GAME");
        return;
      }
      if (room.gameState.phase !== "game_complete") {
        emitGameError(socket, "Game is not complete yet", "GAME_NOT_COMPLETE");
        return;
      }

      startRoomGame(room.roomCode, identity.playerId, socket);
    });

    socket.on("game:end", () => {
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
      if (room.hostPlayerId !== identity.playerId) {
        emitGameError(socket, "Only host can end game", "FORBIDDEN");
        return;
      }
      if (!room.gameState) {
        emitGameError(socket, "No game to end", "NO_ACTIVE_GAME");
        return;
      }
      if (room.gameState.phase === "game_complete") {
        emitGameError(socket, "Game already complete", "GAME_ALREADY_COMPLETE");
        return;
      }

      const endedState = {
        ...room.gameState,
        phase: "game_complete" as const,
        currentRound: null,
        updatedAt: Date.now()
      };
      store.setGameState(room.roomCode, endedState);
      historyStore.recordCompletedGame(room.roomCode, endedState);
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

  return { store, historyStore, httpServer, io };
};
