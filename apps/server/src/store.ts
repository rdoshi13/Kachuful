import type { GameState, RoomJoinResponse, RoomPlayer, RoomStatePayload } from "@kachuful/shared-types";
import { randomUUID } from "node:crypto";

interface Room {
  roomCode: string;
  hostPlayerId: string;
  locked: boolean;
  players: RoomPlayer[];
  gameState: GameState | null;
  lastEmptyAt: number | null;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const createRoomCode = (): string => {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
};

const sanitizeName = (name: string): string => name.trim().slice(0, 32);
const normalizeName = (name: string): string => sanitizeName(name).toLocaleLowerCase();

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly socketIdentity = new Map<string, { roomCode: string; playerId: string }>();
  private readonly seenSocketJoin = new Set<string>();

  createRoom(name: string): { room: Room; response: RoomJoinResponse } {
    const cleanName = sanitizeName(name);
    if (!cleanName) {
      throw new Error("Name is required");
    }

    let roomCode = createRoomCode();
    while (this.rooms.has(roomCode)) {
      roomCode = createRoomCode();
    }

    const playerId = randomUUID();
    const sessionToken = randomUUID();

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
      gameState: null,
      lastEmptyAt: Date.now()
    };

    this.rooms.set(roomCode, room);

    return {
      room,
      response: {
        roomCode,
        playerId,
        sessionToken
      }
    };
  }

  joinRoom(roomCode: string, name: string): { room: Room; response: RoomJoinResponse } {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) {
      throw new Error("Room not found");
    }

    const cleanName = sanitizeName(name);
    if (!cleanName) {
      throw new Error("Name is required");
    }

    const existingPlayer = room.players.find(
      (player) => normalizeName(player.name) === normalizeName(cleanName)
    );

    if (existingPlayer) {
      if (existingPlayer.connected) {
        throw new Error("Name is already in use");
      }

      existingPlayer.sessionToken = randomUUID();
      return {
        room,
        response: {
          roomCode: room.roomCode,
          playerId: existingPlayer.playerId,
          sessionToken: existingPlayer.sessionToken
        }
      };
    }

    if (room.locked) {
      throw new Error("Room is locked");
    }

    if (room.players.length >= 6) {
      throw new Error("Room is full");
    }

    const playerId = randomUUID();
    const sessionToken = randomUUID();

    room.players.push({
      playerId,
      name: cleanName,
      sessionToken,
      connected: false
    });
    if (!room.players.some((player) => player.connected)) {
      room.lastEmptyAt = Date.now();
    }

    return {
      room,
      response: {
        roomCode: room.roomCode,
        playerId,
        sessionToken
      }
    };
  }

  getRoom(roomCode: string): Room | null {
    return this.rooms.get(roomCode.toUpperCase()) ?? null;
  }

  getRoomBySocket(socketId: string): Room | null {
    const identity = this.socketIdentity.get(socketId);
    if (!identity) {
      return null;
    }
    return this.getRoom(identity.roomCode);
  }

  authenticatePlayer(
    roomCode: string,
    playerId: string,
    sessionToken: string
  ): { room: Room; player: RoomPlayer; reconnected: boolean } {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }

    const player = room.players.find((entry) => entry.playerId === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    const host = room.players.find((entry) => entry.playerId === room.hostPlayerId);
    const isHost = player.playerId === room.hostPlayerId;
    if (!isHost && !host?.connected) {
      throw new Error("Host is offline");
    }

    if (player.sessionToken !== sessionToken) {
      throw new Error("Invalid session token");
    }

    const reconnectKey = `${room.roomCode}:${player.playerId}`;
    const reconnected = this.seenSocketJoin.has(reconnectKey);
    return { room, player, reconnected };
  }

  markConnected(roomCode: string, playerId: string, socketId: string): void {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }
    const player = room.players.find((entry) => entry.playerId === playerId);
    if (!player) {
      throw new Error("Player not found");
    }
    player.connected = true;
    room.lastEmptyAt = null;
    this.socketIdentity.set(socketId, { roomCode: room.roomCode, playerId });
    this.seenSocketJoin.add(`${room.roomCode}:${player.playerId}`);
  }

  markDisconnected(socketId: string): { room: Room; player: RoomPlayer } | null {
    const identity = this.socketIdentity.get(socketId);
    if (!identity) {
      return null;
    }

    const room = this.getRoom(identity.roomCode);
    if (!room) {
      this.socketIdentity.delete(socketId);
      return null;
    }

    const player = room.players.find((entry) => entry.playerId === identity.playerId);
    if (!player) {
      this.socketIdentity.delete(socketId);
      return null;
    }

    player.connected = false;
    if (!room.players.some((entry) => entry.connected)) {
      room.lastEmptyAt = Date.now();
    }
    this.socketIdentity.delete(socketId);
    return { room, player };
  }

  pruneInactiveRooms(idleTtlMs: number, now = Date.now()): string[] {
    if (idleTtlMs <= 0) {
      return [];
    }

    const removedRoomCodes: string[] = [];
    for (const room of this.rooms.values()) {
      if (room.players.some((player) => player.connected)) {
        room.lastEmptyAt = null;
        continue;
      }

      if (room.lastEmptyAt === null) {
        room.lastEmptyAt = now;
        continue;
      }

      if (now - room.lastEmptyAt >= idleTtlMs) {
        removedRoomCodes.push(room.roomCode);
      }
    }

    for (const roomCode of removedRoomCodes) {
      this.deleteRoom(roomCode);
    }

    return removedRoomCodes;
  }

  private deleteRoom(roomCode: string): void {
    const normalizedRoomCode = roomCode.toUpperCase();
    this.rooms.delete(normalizedRoomCode);

    for (const [socketId, identity] of this.socketIdentity.entries()) {
      if (identity.roomCode === normalizedRoomCode) {
        this.socketIdentity.delete(socketId);
      }
    }

    for (const key of this.seenSocketJoin) {
      if (key.startsWith(`${normalizedRoomCode}:`)) {
        this.seenSocketJoin.delete(key);
      }
    }
  }

  getIdentityBySocket(socketId: string): { roomCode: string; playerId: string } | null {
    return this.socketIdentity.get(socketId) ?? null;
  }

  setGameState(roomCode: string, gameState: GameState): void {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }
    room.gameState = gameState;
  }

  setRoomLocked(roomCode: string, locked: boolean): void {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new Error("Room not found");
    }
    room.locked = locked;
  }

  getRoomStatePayload(roomCode: string): RoomStatePayload {
    const room = this.getRoom(roomCode);
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

  getConnectedSocketIds(roomCode: string): string[] {
    const ids: string[] = [];
    for (const [socketId, identity] of this.socketIdentity.entries()) {
      if (identity.roomCode === roomCode.toUpperCase()) {
        ids.push(socketId);
      }
    }
    return ids;
  }
}
