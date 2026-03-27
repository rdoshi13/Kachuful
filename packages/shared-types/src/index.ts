export const ROUND_PATTERN = [1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1] as const;
export const TRUMP_SUIT_ORDER = ["S", "D", "C", "H"] as const;

export type Suit = "C" | "D" | "H" | "S";
export type Rank =
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14;

export type CardId = string;

export interface PlayerRef {
  playerId: string;
  name: string;
}

export type Phase =
  | "lobby"
  | "round_setup"
  | "bidding"
  | "trick_play"
  | "round_scoring"
  | "game_complete";

export interface TrickPlay {
  playerId: string;
  cardId: CardId;
}

export interface TrickResult {
  winnerId: string;
  leadSuit: Suit;
  plays: TrickPlay[];
}

export interface RoundState {
  roundIndex: number;
  cardsPerPlayer: number;
  trumpSuit: Suit;
  dealerIndex: number;
  blind: boolean;
  cardsDealt: boolean;
  drawPile: CardId[];
  bids: Record<string, number | null>;
  bidTurnPlayerId: string | null;
  tricksWon: Record<string, number>;
  hands: Record<string, CardId[]>;
  leadPlayerId: string | null;
  turnPlayerId: string | null;
  currentTrick: TrickPlay[];
  trickHistory: TrickResult[];
}

export interface RoundSummary {
  roundIndex: number;
  cardsPerPlayer: number;
  trumpSuit: Suit;
  bids: Record<string, number>;
  tricksWon: Record<string, number>;
  scoreDelta: Record<string, number>;
}

export interface GameState {
  gameId: string;
  players: PlayerRef[];
  phase: Phase;
  scores: Record<string, number>;
  roundNumber: number;
  dealerIndex: number;
  rngSeed: number;
  currentRound: RoundState | null;
  completedRounds: RoundSummary[];
  startedAt: number | null;
  updatedAt: number;
}

export type Command =
  | { type: "start_game"; actorId: string }
  | { type: "submit_bid"; actorId: string; bid: number }
  | { type: "play_card"; actorId: string; cardId: CardId };

export interface EngineError {
  code: string;
  message: string;
}

export interface EngineEvent {
  type:
    | "game_started"
    | "round_started"
    | "bidding_complete"
    | "trick_complete"
    | "round_complete"
    | "game_complete";
  at: number;
  payload?: Record<string, unknown>;
}

export type EngineResult =
  | {
      ok: true;
      state: GameState;
      events: EngineEvent[];
    }
  | {
      ok: false;
      state: GameState;
      error: EngineError;
    };

export interface PublicRoundState {
  roundIndex: number;
  cardsPerPlayer: number;
  trumpSuit: Suit;
  dealerIndex: number;
  blind: boolean;
  cardsDealt: boolean;
  bids: Record<string, number | null>;
  bidTurnPlayerId: string | null;
  tricksWon: Record<string, number>;
  leadPlayerId: string | null;
  turnPlayerId: string | null;
  currentTrick: TrickPlay[];
  trickHistory: TrickResult[];
  handSizes: Record<string, number>;
  viewerHand: CardId[];
  forbiddenDealerBid: number | null;
  legalCardIds: CardId[];
}

export interface PublicGameView {
  gameId: string;
  players: PlayerRef[];
  phase: Phase;
  scores: Record<string, number>;
  roundNumber: number;
  currentRound: PublicRoundState | null;
  completedRounds: RoundSummary[];
}

export interface RoomPlayer extends PlayerRef {
  sessionToken: string;
  connected: boolean;
}

export interface RoomStatePayload {
  roomCode: string;
  hostPlayerId: string;
  locked: boolean;
  players: Array<Pick<RoomPlayer, "playerId" | "name" | "connected">>;
}

export interface CreateRoomRequest {
  name: string;
}

export interface JoinRoomRequest {
  name: string;
}

export interface RoomJoinResponse {
  roomCode: string;
  playerId: string;
  sessionToken: string;
}

export interface MatchHistoryPlayerResult extends PlayerRef {
  score: number;
}

export interface MatchHistoryEntry {
  matchId: string;
  roomCode: string;
  startedAt: number | null;
  completedAt: number;
  roundsPlayed: number;
  winnerPlayerIds: string[];
  players: MatchHistoryPlayerResult[];
  completedRounds: RoundSummary[];
}

export interface RoomHistoryResponse {
  roomCode: string;
  matches: MatchHistoryEntry[];
}
