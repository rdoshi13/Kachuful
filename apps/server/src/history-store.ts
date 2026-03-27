import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GameState, MatchHistoryEntry, RoundSummary } from "@kachuful/shared-types";
import { log } from "./logger.js";

interface PersistedHistoryFile {
  version: 1;
  byRoom: Record<string, MatchHistoryEntry[]>;
}

interface MatchHistoryStoreOptions {
  filePath?: string;
  maxEntriesPerRoom?: number;
}

const DEFAULT_MAX_ENTRIES_PER_ROOM = 100;
const DEFAULT_HISTORY_FILE = process.env.MATCH_HISTORY_FILE ?? path.resolve(process.cwd(), ".data/match-history.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNumericRecord = (value: unknown): value is Record<string, number> => {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "number");
};

const isValidRoundSummary = (value: unknown): value is RoundSummary => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.roundIndex === "number"
    && typeof value.cardsPerPlayer === "number"
    && isNumericRecord(value.bids)
    && isNumericRecord(value.tricksWon)
    && isNumericRecord(value.scoreDelta)
  );
};

const isValidMatchHistoryEntry = (value: unknown): value is MatchHistoryEntry => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.matchId !== "string"
    || typeof value.roomCode !== "string"
    || !(typeof value.startedAt === "number" || value.startedAt === null)
    || typeof value.completedAt !== "number"
    || typeof value.roundsPlayed !== "number"
    || !Array.isArray(value.winnerPlayerIds)
    || !Array.isArray(value.players)
    || !Array.isArray(value.completedRounds)
  ) {
    return false;
  }

  const hasValidWinners = value.winnerPlayerIds.every((entry) => typeof entry === "string");
  const hasValidPlayers = value.players.every((player) =>
    isRecord(player)
    && typeof player.playerId === "string"
    && typeof player.name === "string"
    && typeof player.score === "number"
  );
  const hasValidRounds = value.completedRounds.every((summary) => isValidRoundSummary(summary));

  return hasValidWinners && hasValidPlayers && hasValidRounds;
};

const cloneRoundSummary = (summary: RoundSummary): RoundSummary => ({
  roundIndex: summary.roundIndex,
  cardsPerPlayer: summary.cardsPerPlayer,
  bids: { ...summary.bids },
  tricksWon: { ...summary.tricksWon },
  scoreDelta: { ...summary.scoreDelta }
});

const cloneEntry = (entry: MatchHistoryEntry): MatchHistoryEntry => ({
  ...entry,
  winnerPlayerIds: [...entry.winnerPlayerIds],
  players: entry.players.map((player) => ({ ...player })),
  completedRounds: entry.completedRounds.map(cloneRoundSummary)
});

const toMatchId = (roomCode: string, gameState: GameState): string =>
  `${roomCode}:${gameState.gameId}:${gameState.startedAt ?? "no-start"}:${gameState.updatedAt}`;

export class MatchHistoryStore {
  private readonly filePath: string;
  private readonly maxEntriesPerRoom: number;
  private readonly byRoom: Record<string, MatchHistoryEntry[]>;

  constructor(options: MatchHistoryStoreOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_HISTORY_FILE;
    this.maxEntriesPerRoom = options.maxEntriesPerRoom ?? DEFAULT_MAX_ENTRIES_PER_ROOM;
    this.byRoom = this.loadFromDisk();
  }

  listRoomHistory(roomCode: string, limit = 20): MatchHistoryEntry[] {
    const normalizedRoomCode = roomCode.toUpperCase();
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    const entries = this.byRoom[normalizedRoomCode] ?? [];
    return entries.slice(0, safeLimit).map(cloneEntry);
  }

  recordCompletedGame(roomCode: string, gameState: GameState): MatchHistoryEntry | null {
    if (gameState.phase !== "game_complete") {
      return null;
    }

    const normalizedRoomCode = roomCode.toUpperCase();
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
      matchId: toMatchId(normalizedRoomCode, gameState),
      roomCode: normalizedRoomCode,
      startedAt: gameState.startedAt,
      completedAt: gameState.updatedAt,
      roundsPlayed: gameState.completedRounds.length,
      winnerPlayerIds,
      players,
      completedRounds: gameState.completedRounds.map(cloneRoundSummary)
    };

    const existing = this.byRoom[normalizedRoomCode] ?? [];
    if (existing.some((historyEntry) => historyEntry.matchId === entry.matchId)) {
      return null;
    }

    this.byRoom[normalizedRoomCode] = [entry, ...existing]
      .sort((left, right) => right.completedAt - left.completedAt)
      .slice(0, this.maxEntriesPerRoom);
    this.persistToDisk();
    return cloneEntry(entry);
  }

  private loadFromDisk(): Record<string, MatchHistoryEntry[]> {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.byRoom)) {
        log("warn", "Match history file is malformed, starting fresh", { filePath: this.filePath });
        return {};
      }

      const loaded: Record<string, MatchHistoryEntry[]> = {};
      for (const [roomCode, entries] of Object.entries(parsed.byRoom)) {
        if (!Array.isArray(entries)) {
          continue;
        }
        const validEntries = entries.filter((entry) => isValidMatchHistoryEntry(entry)).map((entry) => cloneEntry(entry));
        if (validEntries.length > 0) {
          loaded[roomCode.toUpperCase()] = validEntries
            .sort((left, right) => right.completedAt - left.completedAt)
            .slice(0, this.maxEntriesPerRoom);
        }
      }
      return loaded;
    } catch (error) {
      log("warn", "Failed to load match history, starting fresh", {
        filePath: this.filePath,
        error: (error as Error).message
      });
      return {};
    }
  }

  private persistToDisk(): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });

    const payload: PersistedHistoryFile = {
      version: 1,
      byRoom: this.byRoom
    };

    const tempFile = `${this.filePath}.tmp`;
    writeFileSync(tempFile, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tempFile, this.filePath);
  }
}
