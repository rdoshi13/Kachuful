import { DurableObject } from "cloudflare:workers";
import { applyCommand, createGame, getPublicView } from "@kachuful/game-engine";
import type {
  Command,
  GameState,
  MatchHistoryEntry,
  RoomJoinResponse,
  RoomTransferResponse,
  RoomPlayer,
  RoomStatePayload,
  TransferSeatRequest
} from "@kachuful/shared-types";

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TRANSFER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TRANSFER_CODE_LENGTH = 6;
const TRANSFER_CODE_TTL_MS = 2 * 60 * 1000;
const MAX_PLAYERS_PER_ROOM = 6;
const MAX_HISTORY_PER_ROOM = 100;
const MATCH_HISTORY_LIMIT_MAX = 100;

interface Env {
  GAME_HUB: DurableObjectNamespace<GameHub>;
}

interface Room {
  roomCode: string;
  hostPlayerId: string;
  locked: boolean;
  players: RoomPlayer[];
  gameState: GameState | null;
}

interface SocketIdentity {
  roomCode: string;
  playerId: string;
}

interface TransferCodeEntry {
  roomCode: string;
  playerId: string;
  expiresAt: number;
}

interface PersistedState {
  rooms: Room[];
  historyByRoom: Record<string, MatchHistoryEntry[]>;
  seenSocketJoin: string[];
  transferCodes: Record<string, TransferCodeEntry>;
}

interface WireMessage {
  event: string;
  payload?: unknown;
}

interface TrickRevealPayload {
  winnerId: string;
  winnerCardId: string;
  trickCount: number;
  roundIndex: number;
  plays: Array<{ playerId: string; cardId: string }>;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

const jsonResponse = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json"
    }
  });

const emptyResponse = (status: number): Response =>
  new Response(null, {
    status,
    headers: CORS_HEADERS
  });

const createRoomCode = (): string => {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
};

const sanitizeName = (name: string): string => name.trim().slice(0, 32);
const normalizeName = (name: string): string => sanitizeName(name).toLocaleLowerCase();

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

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

const getActiveTurnPlayerId = (gameState: GameState | null): string | null => {
  if (!gameState || gameState.phase === "game_complete") {
    return null;
  }
  if (!gameState.currentRound) {
    return null;
  }
  if (gameState.phase === "bidding") {
    return gameState.currentRound.bidTurnPlayerId ?? null;
  }
  if (gameState.phase === "trick_play") {
    return gameState.currentRound.turnPlayerId ?? null;
  }
  return null;
};

const parseJsonBody = async <T>(request: Request): Promise<T | null> => {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
};

const cloneHistoryEntry = (entry: MatchHistoryEntry): MatchHistoryEntry => ({
  ...entry,
  winnerPlayerIds: [...entry.winnerPlayerIds],
  players: entry.players.map((player) => ({ ...player })),
  completedRounds: entry.completedRounds.map((round) => ({
    roundIndex: round.roundIndex,
    cardsPerPlayer: round.cardsPerPlayer,
    trumpSuit: round.trumpSuit,
    bids: { ...round.bids },
    tricksWon: { ...round.tricksWon },
    scoreDelta: { ...round.scoreDelta }
  }))
});

const toMatchId = (roomCode: string, gameState: GameState): string =>
  `${roomCode}:${gameState.gameId}:${gameState.startedAt ?? "no-start"}:${gameState.updatedAt}`;

const upgradeHeaderIsWebSocket = (request: Request): boolean =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";

export class GameHub extends DurableObject<Env> {
  private rooms = new Map<string, Room>();
  private historyByRoom: Record<string, MatchHistoryEntry[]> = {};
  private transferCodes = new Map<string, TransferCodeEntry>();
  private readonly socketIdentity = new Map<WebSocket, SocketIdentity>();
  private readonly roomSockets = new Map<string, Set<WebSocket>>();
  private seenSocketJoin = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const persisted = await this.ctx.storage.get<PersistedState>("state");
      if (!persisted) {
        return;
      }
      this.rooms = new Map(
        (persisted.rooms ?? []).map((room) => [room.roomCode.toUpperCase(), room])
      );
      this.historyByRoom = persisted.historyByRoom ?? {};
      this.seenSocketJoin = new Set(persisted.seenSocketJoin ?? []);
      this.transferCodes = new Map(
        Object.entries(persisted.transferCodes ?? {}).map(([code, entry]) => [
          code.toUpperCase(),
          entry
        ])
      );
      this.removeExpiredTransferCodes();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return emptyResponse(204);
    }

    const url = new URL(request.url);
    const joinMatch = url.pathname.match(/^\/rooms\/([^/]+)\/join$/);
    const transferMatch = url.pathname.match(/^\/rooms\/([^/]+)\/transfer$/);
    const historyMatch = url.pathname.match(/^\/rooms\/([^/]+)\/history$/);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, { ok: true });
    }

    if (url.pathname === "/ws") {
      return this.handleWebSocketUpgrade(request);
    }

    if (request.method === "POST" && url.pathname === "/rooms") {
      return this.handleCreateRoom(request);
    }

    if (request.method === "POST" && joinMatch) {
      return this.handleJoinRoom(request, joinMatch[1] ?? "");
    }

    if (request.method === "POST" && transferMatch) {
      return this.handleTransferSeat(request, transferMatch[1] ?? "");
    }

    if (request.method === "GET" && historyMatch) {
      return this.handleHistory(url, historyMatch[1] ?? "");
    }

    return jsonResponse(404, { error: "Not found" });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    if (!upgradeHeaderIsWebSocket(request)) {
      return jsonResponse(426, { error: "Expected WebSocket upgrade request" });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    server.addEventListener("message", (event) => {
      void this.handleSocketMessage(server, event.data);
    });
    server.addEventListener("close", () => {
      void this.handleSocketClose(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private async handleCreateRoom(request: Request): Promise<Response> {
    const body = await parseJsonBody<{ name?: unknown }>(request);
    const rawName = body?.name;
    if (typeof rawName !== "string") {
      return jsonResponse(400, { error: "Name is required" });
    }

    const cleanName = sanitizeName(rawName);
    if (!cleanName) {
      return jsonResponse(400, { error: "Name is required" });
    }

    let roomCode = createRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = createRoomCode();
    }

    const playerId = crypto.randomUUID();
    const sessionToken = crypto.randomUUID();

    const player: RoomPlayer = {
      playerId,
      name: cleanName,
      sessionToken,
      connected: false
    };

    const room: Room = {
      roomCode,
      hostPlayerId: playerId,
      locked: false,
      players: [player],
      gameState: null
    };

    this.rooms.set(roomCode, room);
    await this.persistState();

    const response: RoomJoinResponse = {
      roomCode,
      playerId,
      sessionToken
    };
    return jsonResponse(201, response);
  }

  private async handleJoinRoom(request: Request, roomCodeParam: string): Promise<Response> {
    const roomCode = roomCodeParam.toUpperCase();
    const body = await parseJsonBody<{ name?: unknown }>(request);
    const rawName = body?.name;
    if (typeof rawName !== "string") {
      return jsonResponse(400, { error: "Name is required" });
    }

    const cleanName = sanitizeName(rawName);
    if (!cleanName) {
      return jsonResponse(400, { error: "Name is required" });
    }

    const room = this.rooms.get(roomCode);
    if (!room) {
      return jsonResponse(404, { error: "Room not found" });
    }
    if (room.locked) {
      return jsonResponse(409, { error: "Room is locked" });
    }

    const existingPlayer = room.players.find(
      (player) => normalizeName(player.name) === normalizeName(cleanName)
    );
    if (existingPlayer) {
      if (existingPlayer.connected) {
        return jsonResponse(409, { error: "Name is already in use" });
      }

      existingPlayer.sessionToken = crypto.randomUUID();
      await this.persistState();

      const response: RoomJoinResponse = {
        roomCode: room.roomCode,
        playerId: existingPlayer.playerId,
        sessionToken: existingPlayer.sessionToken
      };
      return jsonResponse(200, response);
    }

    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      return jsonResponse(409, { error: "Room is full" });
    }

    const playerId = crypto.randomUUID();
    const sessionToken = crypto.randomUUID();
    room.players.push({
      playerId,
      name: cleanName,
      sessionToken,
      connected: false
    });

    await this.persistState();

    const response: RoomJoinResponse = {
      roomCode: room.roomCode,
      playerId,
      sessionToken
    };
    return jsonResponse(200, response);
  }

  private handleHistory(url: URL, roomCodeParam: string): Response {
    const roomCode = roomCodeParam.toUpperCase();
    const rawLimit = Number(url.searchParams.get("limit") ?? 20);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), MATCH_HISTORY_LIMIT_MAX)
      : 20;

    return jsonResponse(200, {
      roomCode,
      matches: (this.historyByRoom[roomCode] ?? []).slice(0, limit).map(cloneHistoryEntry)
    });
  }

  private async handleTransferSeat(request: Request, roomCodeParam: string): Promise<Response> {
    const roomCode = roomCodeParam.toUpperCase();
    const body = await parseJsonBody<Partial<TransferSeatRequest>>(request);
    const transferCodeRaw = body?.transferCode;
    if (typeof transferCodeRaw !== "string" || !transferCodeRaw.trim()) {
      return jsonResponse(400, { error: "Transfer code is required" });
    }

    const now = Date.now();
    const transferCode = transferCodeRaw.trim().toUpperCase();
    const transfer = this.transferCodes.get(transferCode);
    if (!transfer || transfer.roomCode !== roomCode) {
      return jsonResponse(409, { error: "Invalid transfer code" });
    }
    if (transfer.expiresAt <= now) {
      this.transferCodes.delete(transferCode);
      await this.persistState();
      return jsonResponse(409, { error: "Transfer code expired" });
    }
    this.removeExpiredTransferCodes(now);

    const room = this.rooms.get(roomCode);
    if (!room) {
      this.transferCodes.delete(transferCode);
      await this.persistState();
      return jsonResponse(404, { error: "Room not found" });
    }

    const player = room.players.find((entry) => entry.playerId === transfer.playerId);
    if (!player) {
      this.transferCodes.delete(transferCode);
      await this.persistState();
      return jsonResponse(404, { error: "Player not found" });
    }

    const host = room.players.find((entry) => entry.playerId === room.hostPlayerId);
    if (player.playerId !== room.hostPlayerId && !host?.connected) {
      return jsonResponse(409, { error: "Host is offline" });
    }

    player.sessionToken = crypto.randomUUID();
    this.transferCodes.delete(transferCode);
    this.deleteTransferCodesForPlayer(room.roomCode, player.playerId);

    await this.persistState();
    this.disconnectPlayerSockets(room.roomCode, player.playerId);

    const response: RoomTransferResponse = {
      roomCode: room.roomCode,
      playerId: player.playerId,
      sessionToken: player.sessionToken,
      name: player.name
    };
    return jsonResponse(200, response);
  }

  private async handleSocketMessage(socket: WebSocket, rawData: string | ArrayBuffer): Promise<void> {
    const rawString = typeof rawData === "string" ? rawData : new TextDecoder().decode(rawData);
    let message: WireMessage;
    try {
      message = JSON.parse(rawString) as WireMessage;
    } catch {
      this.emitGameError(socket, "Malformed message payload", "BAD_REQUEST");
      return;
    }

    if (!message?.event || typeof message.event !== "string") {
      this.emitGameError(socket, "Missing event name", "BAD_REQUEST");
      return;
    }

    switch (message.event) {
      case "room:join":
        await this.handleRoomJoin(socket, message.payload);
        return;
      case "session:transfer_request":
        await this.handleTransferRequest(socket);
        return;
      case "game:start":
        await this.handleGameStart(socket);
        return;
      case "room:lock_toggle":
        await this.handleRoomLockToggle(socket, message.payload);
        return;
      case "game:restart":
        await this.handleGameRestart(socket);
        return;
      case "game:end":
        await this.handleGameEnd(socket);
        return;
      case "bid:submit":
        await this.handleBidSubmit(socket, message.payload);
        return;
      case "card:play":
        await this.handleCardPlay(socket, message.payload);
        return;
      case "state:sync_request":
        this.handleStateSyncRequest(socket);
        return;
      case "turn:poke":
        await this.handleTurnPoke(socket, message.payload);
        return;
      default:
        this.emitGameError(socket, `Unsupported event: ${message.event}`, "BAD_EVENT");
    }
  }

  private async handleTransferRequest(socket: WebSocket): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }

    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }
    const player = room.players.find((entry) => entry.playerId === identity.playerId);
    if (!player) {
      this.emitGameError(socket, "Player not found", "NOT_JOINED");
      return;
    }

    const now = Date.now();
    this.removeExpiredTransferCodes(now);
    this.deleteTransferCodesForPlayer(room.roomCode, player.playerId);

    const expiresAt = now + TRANSFER_CODE_TTL_MS;
    let transferCode = this.generateTransferCode();
    while (this.transferCodes.has(transferCode)) {
      transferCode = this.generateTransferCode();
    }
    this.transferCodes.set(transferCode, {
      roomCode: room.roomCode,
      playerId: player.playerId,
      expiresAt
    });

    await this.persistState();
    this.emit(socket, "session:transfer_code", {
      transferCode,
      expiresAt
    });
  }

  private async handleTurnPoke(socket: WebSocket, payload: unknown): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }

    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }

    const activeTurnPlayerId = getActiveTurnPlayerId(room.gameState);
    if (!activeTurnPlayerId) {
      this.emitGameError(socket, "No active turn to remind", "NO_ACTIVE_TURN");
      return;
    }

    const body = asObject(payload);
    const targetPlayerId = body?.targetPlayerId;
    if (typeof targetPlayerId !== "string" || targetPlayerId !== activeTurnPlayerId) {
      this.emitGameError(socket, "Can only remind the current-turn player", "INVALID_TARGET");
      return;
    }

    this.broadcastRoomEvent(room.roomCode, "turn:poked", {
      targetPlayerId,
      byPlayerId: identity.playerId,
      at: Date.now()
    });
  }

  private async handleSocketClose(socket: WebSocket): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      return;
    }

    this.socketIdentity.delete(socket);
    const roomSockets = this.roomSockets.get(identity.roomCode);
    if (roomSockets) {
      roomSockets.delete(socket);
      if (roomSockets.size === 0) {
        this.roomSockets.delete(identity.roomCode);
      }
    }

    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      return;
    }

    const player = room.players.find((entry) => entry.playerId === identity.playerId);
    if (!player) {
      return;
    }

    player.connected = false;
    await this.persistState();
    this.broadcastRoomState(room.roomCode);
  }

  private async handleRoomJoin(socket: WebSocket, payload: unknown): Promise<void> {
    const body = asObject(payload);
    const roomCodeValue = body?.roomCode;
    const playerIdValue = body?.playerId;
    const sessionTokenValue = body?.sessionToken;
    if (
      typeof roomCodeValue !== "string"
      || typeof playerIdValue !== "string"
      || typeof sessionTokenValue !== "string"
    ) {
      this.emitGameError(socket, "room:join requires roomCode, playerId, sessionToken", "BAD_REQUEST");
      return;
    }

    const roomCode = roomCodeValue.toUpperCase();
    const room = this.rooms.get(roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "AUTH_FAILED");
      return;
    }

    const player = room.players.find((entry) => entry.playerId === playerIdValue);
    if (!player) {
      this.emitGameError(socket, "Player not found", "AUTH_FAILED");
      return;
    }

    if (player.sessionToken !== sessionTokenValue) {
      this.emitGameError(socket, "Invalid session token", "AUTH_FAILED");
      return;
    }

    const reconnectKey = `${room.roomCode}:${player.playerId}`;
    const reconnected = this.seenSocketJoin.has(reconnectKey);
    this.seenSocketJoin.add(reconnectKey);

    const existingIdentity = this.socketIdentity.get(socket);
    if (existingIdentity && existingIdentity.roomCode !== room.roomCode) {
      this.roomSockets.get(existingIdentity.roomCode)?.delete(socket);
    }

    player.connected = true;
    this.socketIdentity.set(socket, { roomCode: room.roomCode, playerId: player.playerId });
    if (!this.roomSockets.has(room.roomCode)) {
      this.roomSockets.set(room.roomCode, new Set());
    }
    this.roomSockets.get(room.roomCode)!.add(socket);

    await this.persistState();
    this.emit(socket, "room:state", this.getRoomStatePayload(room.roomCode));
    this.broadcastRoomState(room.roomCode);

    if (room.gameState) {
      this.emit(socket, "game:state", getPublicView(room.gameState, player.playerId));
    }

    if (reconnected) {
      this.broadcastRoomEvent(room.roomCode, "player:reconnected", {
        playerId: player.playerId,
        roomCode: room.roomCode
      });
    }
  }

  private async handleGameStart(socket: WebSocket): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }
    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }
    if (room.gameState) {
      this.emitGameError(socket, "Game already started", "ALREADY_STARTED");
      return;
    }
    if (room.hostPlayerId !== identity.playerId) {
      this.emitGameError(socket, "Only host can start game", "FORBIDDEN");
      return;
    }

    await this.startRoomGame(room.roomCode, identity.playerId, socket);
  }

  private async handleGameRestart(socket: WebSocket): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }
    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }
    if (room.hostPlayerId !== identity.playerId) {
      this.emitGameError(socket, "Only host can restart game", "FORBIDDEN");
      return;
    }
    if (!room.gameState) {
      this.emitGameError(socket, "No game to restart", "NO_ACTIVE_GAME");
      return;
    }
    if (room.gameState.phase !== "game_complete") {
      this.emitGameError(socket, "Game is not complete yet", "GAME_NOT_COMPLETE");
      return;
    }

    await this.startRoomGame(room.roomCode, identity.playerId, socket);
  }

  private async handleRoomLockToggle(socket: WebSocket, payload: unknown): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }

    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }
    if (room.hostPlayerId !== identity.playerId) {
      this.emitGameError(socket, "Only host can change room lock", "FORBIDDEN");
      return;
    }

    const body = asObject(payload);
    const lockedFromPayload = body?.locked;
    const nextLocked = typeof lockedFromPayload === "boolean"
      ? lockedFromPayload
      : !room.locked;

    room.locked = nextLocked;
    await this.persistState();
    this.broadcastRoomState(room.roomCode);
  }

  private async handleGameEnd(socket: WebSocket): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }

    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }
    if (room.hostPlayerId !== identity.playerId) {
      this.emitGameError(socket, "Only host can end game", "FORBIDDEN");
      return;
    }
    if (!room.gameState) {
      this.emitGameError(socket, "No game to end", "NO_ACTIVE_GAME");
      return;
    }
    if (room.gameState.phase === "game_complete") {
      this.emitGameError(socket, "Game already complete", "GAME_ALREADY_COMPLETE");
      return;
    }

    const endedState: GameState = {
      ...room.gameState,
      phase: "game_complete",
      currentRound: null,
      updatedAt: Date.now()
    };
    room.gameState = endedState;
    this.recordCompletedGame(room.roomCode, endedState);

    await this.persistState();
    this.broadcastGameState(room.roomCode);
  }

  private async handleBidSubmit(socket: WebSocket, payload: unknown): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }
    const body = asObject(payload);
    if (typeof body?.bid !== "number") {
      this.emitGameError(socket, "bid:submit requires numeric bid", "BAD_REQUEST");
      return;
    }

    await this.applyAndBroadcast(identity.roomCode, {
      type: "submit_bid",
      actorId: identity.playerId,
      bid: body.bid
    }, socket);
  }

  private async handleCardPlay(socket: WebSocket, payload: unknown): Promise<void> {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }
    const body = asObject(payload);
    if (typeof body?.cardId !== "string") {
      this.emitGameError(socket, "card:play requires cardId", "BAD_REQUEST");
      return;
    }

    await this.applyAndBroadcast(identity.roomCode, {
      type: "play_card",
      actorId: identity.playerId,
      cardId: body.cardId
    }, socket);
  }

  private handleStateSyncRequest(socket: WebSocket): void {
    const identity = this.socketIdentity.get(socket);
    if (!identity) {
      this.emitGameError(socket, "Join room first", "NOT_JOINED");
      return;
    }
    const room = this.rooms.get(identity.roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }

    this.emit(socket, "room:state", this.getRoomStatePayload(room.roomCode));
    if (room.gameState) {
      this.emit(socket, "game:state", getPublicView(room.gameState, identity.playerId));
    }
  }

  private async applyAndBroadcast(roomCodeParam: string, command: Command, socket: WebSocket): Promise<void> {
    const roomCode = roomCodeParam.toUpperCase();
    const room = this.rooms.get(roomCode);
    if (!room?.gameState) {
      this.emitGameError(socket, "Game has not started", "NO_ACTIVE_GAME");
      return;
    }

    const wasComplete = room.gameState.phase === "game_complete";
    const result = applyCommand(room.gameState, command);
    if (!result.ok) {
      this.emitGameError(socket, result.error.message, result.error.code);
      return;
    }

    room.gameState = result.state;
    for (const event of result.events) {
      if (event.type !== "trick_complete") {
        continue;
      }
      const payload = asTrickRevealPayload(event.payload);
      if (!payload) {
        continue;
      }
      this.broadcastRoomEvent(roomCode, "game:trick_reveal", payload);
    }
    if (!wasComplete && result.state.phase === "game_complete") {
      this.recordCompletedGame(roomCode, result.state);
    }

    await this.persistState();
    this.broadcastGameState(roomCode);
  }

  private async startRoomGame(roomCodeParam: string, hostPlayerId: string, socket: WebSocket): Promise<void> {
    const roomCode = roomCodeParam.toUpperCase();
    const room = this.rooms.get(roomCode);
    if (!room) {
      this.emitGameError(socket, "Room not found", "ROOM_NOT_FOUND");
      return;
    }
    const activePlayers = room.players.filter((player) => player.connected);
    if (activePlayers.length < 2) {
      this.emitGameError(socket, "At least 2 active players required", "MIN_PLAYERS");
      return;
    }
    if (room.gameState?.phase === "game_complete") {
      this.recordCompletedGame(roomCode, room.gameState);
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
      this.emitGameError(socket, started.error.message, started.error.code);
      return;
    }

    room.gameState = started.state;
    await this.persistState();
    this.broadcastRoomState(roomCode);
    this.broadcastGameState(roomCode);
  }

  private recordCompletedGame(roomCodeParam: string, gameState: GameState): void {
    if (gameState.phase !== "game_complete") {
      return;
    }

    const roomCode = roomCodeParam.toUpperCase();
    const players = gameState.players
      .map((player) => ({
        playerId: player.playerId,
        name: player.name,
        score: gameState.scores[player.playerId] ?? 0
      }))
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    const topScore = players[0]?.score;
    const winnerPlayerIds = topScore === undefined
      ? []
      : players.filter((player) => player.score === topScore).map((player) => player.playerId);

    const entry: MatchHistoryEntry = {
      matchId: toMatchId(roomCode, gameState),
      roomCode,
      startedAt: gameState.startedAt,
      completedAt: gameState.updatedAt,
      roundsPlayed: gameState.completedRounds.length,
      winnerPlayerIds,
      players,
      completedRounds: gameState.completedRounds.map((round) => ({
        roundIndex: round.roundIndex,
        cardsPerPlayer: round.cardsPerPlayer,
        trumpSuit: round.trumpSuit,
        bids: { ...round.bids },
        tricksWon: { ...round.tricksWon },
        scoreDelta: { ...round.scoreDelta }
      }))
    };

    const current = this.historyByRoom[roomCode] ?? [];
    if (current.some((historyEntry) => historyEntry.matchId === entry.matchId)) {
      return;
    }
    this.historyByRoom[roomCode] = [entry, ...current]
      .sort((left, right) => right.completedAt - left.completedAt)
      .slice(0, MAX_HISTORY_PER_ROOM);
  }

  private getRoomStatePayload(roomCodeParam: string): RoomStatePayload {
    const roomCode = roomCodeParam.toUpperCase();
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }
    return {
      roomCode: room.roomCode,
      hostPlayerId: room.hostPlayerId,
      locked: room.locked,
      players: room.players.map((player) => ({
        playerId: player.playerId,
        name: player.name,
        connected: player.connected
      }))
    };
  }

  private broadcastRoomState(roomCodeParam: string): void {
    const roomCode = roomCodeParam.toUpperCase();
    const sockets = this.roomSockets.get(roomCode);
    if (!sockets || sockets.size === 0) {
      return;
    }
    const payload = this.getRoomStatePayload(roomCode);
    for (const socket of sockets) {
      this.emit(socket, "room:state", payload);
    }
  }

  private broadcastGameState(roomCodeParam: string): void {
    const roomCode = roomCodeParam.toUpperCase();
    const room = this.rooms.get(roomCode);
    if (!room?.gameState) {
      return;
    }
    const sockets = this.roomSockets.get(roomCode);
    if (!sockets || sockets.size === 0) {
      return;
    }

    for (const socket of sockets) {
      const identity = this.socketIdentity.get(socket);
      if (!identity) {
        continue;
      }
      this.emit(socket, "game:state", getPublicView(room.gameState, identity.playerId));
    }
  }

  private broadcastRoomEvent(roomCodeParam: string, event: string, payload: unknown): void {
    const roomCode = roomCodeParam.toUpperCase();
    const sockets = this.roomSockets.get(roomCode);
    if (!sockets || sockets.size === 0) {
      return;
    }
    for (const socket of sockets) {
      this.emit(socket, event, payload);
    }
  }

  private disconnectPlayerSockets(roomCodeParam: string, playerId: string): void {
    const roomCode = roomCodeParam.toUpperCase();
    for (const [socket, identity] of this.socketIdentity.entries()) {
      if (identity.roomCode !== roomCode || identity.playerId !== playerId) {
        continue;
      }
      try {
        socket.close(4001, "Seat transferred");
      } catch {
        // Ignore close errors from stale sockets.
      }
    }
  }

  private deleteTransferCodesForPlayer(roomCodeParam: string, playerId: string): void {
    const roomCode = roomCodeParam.toUpperCase();
    for (const [code, entry] of this.transferCodes.entries()) {
      if (entry.roomCode === roomCode && entry.playerId === playerId) {
        this.transferCodes.delete(code);
      }
    }
  }

  private removeExpiredTransferCodes(now = Date.now()): void {
    for (const [code, entry] of this.transferCodes.entries()) {
      if (entry.expiresAt <= now) {
        this.transferCodes.delete(code);
      }
    }
  }

  private generateTransferCode(): string {
    let code = "";
    for (let index = 0; index < TRANSFER_CODE_LENGTH; index += 1) {
      code += TRANSFER_CODE_ALPHABET[Math.floor(Math.random() * TRANSFER_CODE_ALPHABET.length)];
    }
    return code;
  }

  private emit(socket: WebSocket, event: string, payload?: unknown): void {
    try {
      if (socket.readyState !== 1) {
        return;
      }
      const message: WireMessage = { event, payload };
      socket.send(JSON.stringify(message));
    } catch {
      // Ignore send errors on stale sockets.
    }
  }

  private emitGameError(socket: WebSocket, message: string, code = "BAD_REQUEST"): void {
    this.emit(socket, "game:error", { code, message });
  }

  private async persistState(): Promise<void> {
    const snapshot: PersistedState = {
      rooms: [...this.rooms.values()],
      historyByRoom: this.historyByRoom,
      seenSocketJoin: [...this.seenSocketJoin],
      transferCodes: Object.fromEntries(this.transferCodes.entries())
    };
    await this.ctx.storage.put("state", snapshot);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.GAME_HUB.idFromName("global");
    return env.GAME_HUB.get(id).fetch(request);
  }
};
