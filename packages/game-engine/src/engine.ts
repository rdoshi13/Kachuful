import {
  ROUND_PATTERN,
  type CardId,
  type Command,
  type EngineError,
  type EngineEvent,
  type EngineResult,
  type GameState,
  type PlayerRef,
  type PublicGameView,
  type RoundState,
  type RoundSummary,
  type Suit,
  type TrickPlay,
  type TrickResult
} from "@kachuful/shared-types";
import { getCardRank, getCardSuit, getDeck, hasSuit, shuffleWithSeed } from "./cards.js";

const now = (): number => Date.now();

const ok = (state: GameState, events: EngineEvent[]): EngineResult => ({ ok: true, state, events });

const fail = (state: GameState, code: string, message: string): EngineResult => ({
  ok: false,
  state,
  error: { code, message }
});

const getPlayerIndex = (state: GameState, playerId: string): number =>
  state.players.findIndex((player) => player.playerId === playerId);

const getNextPlayerId = (state: GameState, playerId: string): string => {
  const index = getPlayerIndex(state, playerId);
  if (index < 0) {
    throw new Error(`Unknown player ${playerId}`);
  }
  return state.players[(index + 1) % state.players.length]!.playerId;
};

const initScoreMap = (state: GameState): Record<string, number> =>
  Object.fromEntries(state.players.map((player) => [player.playerId, 0]));

const initNullableBidMap = (state: GameState): Record<string, number | null> =>
  Object.fromEntries(state.players.map((player) => [player.playerId, null]));

const initHands = (state: GameState): Record<string, CardId[]> =>
  Object.fromEntries(state.players.map((player) => [player.playerId, []]));

const isDealerTurn = (round: RoundState, playerId: string, players: PlayerRef[]): boolean => {
  const dealerId = players[round.dealerIndex]?.playerId;
  return dealerId === playerId;
};

const getForbiddenDealerBid = (
  round: RoundState,
  players: PlayerRef[]
): number | null => {
  if (!round.bidTurnPlayerId) {
    return null;
  }
  if (!isDealerTurn(round, round.bidTurnPlayerId, players)) {
    return null;
  }
  const sum = Object.values(round.bids).reduce<number>((acc, value) => acc + (value ?? 0), 0);
  return round.cardsPerPlayer - sum;
};

const buildRound = (state: GameState, roundIndex: number): { state: GameState; event: EngineEvent } => {
  const cardsPerPlayer = ROUND_PATTERN[roundIndex];
  if (!cardsPerPlayer) {
    throw new Error(`Invalid round index ${roundIndex}`);
  }

  const dealerIndex = (state.dealerIndex + 1) % state.players.length;
  const blind = cardsPerPlayer === 1;
  const { shuffled, nextSeed } = shuffleWithSeed(getDeck(), state.rngSeed);

  const round: RoundState = {
    roundIndex,
    cardsPerPlayer,
    dealerIndex,
    blind,
    cardsDealt: !blind,
    drawPile: shuffled,
    bids: initNullableBidMap(state),
    bidTurnPlayerId: state.players[(dealerIndex + 1) % state.players.length]?.playerId ?? null,
    tricksWon: initScoreMap(state),
    hands: initHands(state),
    leadPlayerId: state.players[(dealerIndex + 1) % state.players.length]?.playerId ?? null,
    turnPlayerId: state.players[(dealerIndex + 1) % state.players.length]?.playerId ?? null,
    currentTrick: [],
    trickHistory: []
  };

  if (!blind) {
    for (let cardIndex = 0; cardIndex < cardsPerPlayer; cardIndex += 1) {
      for (const player of state.players) {
        const cardId = round.drawPile.shift();
        if (!cardId) {
          throw new Error("Deck exhausted while dealing");
        }
        round.hands[player.playerId]!.push(cardId);
      }
    }
  }

  return {
    state: {
      ...state,
      phase: "bidding",
      currentRound: round,
      roundNumber: roundIndex,
      dealerIndex,
      rngSeed: nextSeed,
      updatedAt: state.updatedAt + 1
    },
    event: {
      type: "round_started",
      at: now(),
      payload: { roundIndex, cardsPerPlayer, dealerIndex, blind }
    }
  };
};

const completeRound = (state: GameState): { state: GameState; events: EngineEvent[] } => {
  const round = state.currentRound;
  if (!round) {
    throw new Error("No current round to complete");
  }

  const bids = Object.fromEntries(
    Object.entries(round.bids).map(([playerId, bid]) => [playerId, bid ?? 0])
  );

  const scoreDelta: Record<string, number> = {};
  const nextScores: Record<string, number> = { ...state.scores };

  for (const player of state.players) {
    const playerId = player.playerId;
    const bid = bids[playerId] ?? 0;
    const tricks = round.tricksWon[playerId] ?? 0;
    const delta = tricks === bid ? 10 + tricks : 0;
    scoreDelta[playerId] = delta;
    nextScores[playerId] = (nextScores[playerId] ?? 0) + delta;
  }

  const summary: RoundSummary = {
    roundIndex: round.roundIndex,
    cardsPerPlayer: round.cardsPerPlayer,
    bids,
    tricksWon: { ...round.tricksWon },
    scoreDelta
  };

  const scoringState: GameState = {
    ...state,
    phase: "round_scoring",
    scores: nextScores,
    completedRounds: [...state.completedRounds, summary],
    updatedAt: state.updatedAt + 1
  };

  const events: EngineEvent[] = [{
    type: "round_complete",
    at: now(),
    payload: { roundIndex: round.roundIndex, scoreDelta }
  }];

  if (round.roundIndex === ROUND_PATTERN.length - 1) {
    return {
      state: {
        ...scoringState,
        phase: "game_complete",
        currentRound: null,
        updatedAt: scoringState.updatedAt + 1
      },
      events: [...events, { type: "game_complete", at: now() }]
    };
  }

  const nextRound = buildRound(scoringState, round.roundIndex + 1);
  return {
    state: nextRound.state,
    events: [...events, nextRound.event]
  };
};

const dealBlindHands = (state: GameState): GameState => {
  const round = state.currentRound;
  if (!round) {
    return state;
  }

  const nextRound: RoundState = {
    ...round,
    cardsDealt: true,
    hands: { ...round.hands },
    drawPile: [...round.drawPile]
  };

  for (const player of state.players) {
    const cardId = nextRound.drawPile.shift();
    if (!cardId) {
      throw new Error("Deck exhausted while dealing blind hands");
    }
    nextRound.hands[player.playerId] = [cardId];
  }

  return { ...state, currentRound: nextRound, updatedAt: state.updatedAt + 1 };
};

const resolveTrickWinner = (trick: TrickPlay[]): { winnerId: string; leadSuit: Suit } => {
  const leadSuit = getCardSuit(trick[0]!.cardId);

  let winner = trick[0]!;
  let winnerRank = getCardRank(winner.cardId);

  for (let index = 1; index < trick.length; index += 1) {
    const current = trick[index]!;
    const suit = getCardSuit(current.cardId);
    if (suit !== leadSuit) {
      continue;
    }
    const rank = getCardRank(current.cardId);
    if (rank > winnerRank) {
      winner = current;
      winnerRank = rank;
    }
  }

  return { winnerId: winner.playerId, leadSuit };
};

export const createGame = (params: {
  gameId: string;
  players: PlayerRef[];
  seed?: number;
}): GameState => {
  if (params.players.length < 2) {
    throw new Error("At least 2 players are required");
  }

  const state: GameState = {
    gameId: params.gameId,
    players: [...params.players],
    phase: "lobby",
    scores: Object.fromEntries(params.players.map((player) => [player.playerId, 0])),
    roundNumber: -1,
    dealerIndex: params.players.length - 1,
    rngSeed: params.seed ?? 123456789,
    currentRound: null,
    completedRounds: [],
    startedAt: null,
    updatedAt: 0
  };

  return state;
};

export const applyCommand = (state: GameState, command: Command): EngineResult => {
  const actorIndex = getPlayerIndex(state, command.actorId);
  if (actorIndex < 0) {
    return fail(state, "UNKNOWN_PLAYER", "Player is not part of this game");
  }

  if (command.type === "start_game") {
    if (state.phase !== "lobby") {
      return fail(state, "INVALID_PHASE", "Game has already started");
    }

    const hostId = state.players[0]?.playerId;
    if (command.actorId !== hostId) {
      return fail(state, "FORBIDDEN", "Only host can start the game");
    }

    const started: GameState = {
      ...state,
      phase: "round_setup",
      startedAt: state.updatedAt + 1,
      updatedAt: state.updatedAt + 1
    };
    const firstRound = buildRound(started, 0);

    return ok(firstRound.state, [
      { type: "game_started", at: now(), payload: { actorId: command.actorId } },
      firstRound.event
    ]);
  }

  const round = state.currentRound;
  if (!round) {
    return fail(state, "NO_ACTIVE_ROUND", "No active round");
  }

  if (command.type === "submit_bid") {
    if (state.phase !== "bidding") {
      return fail(state, "INVALID_PHASE", "Bidding is not active");
    }

    if (round.bidTurnPlayerId !== command.actorId) {
      return fail(state, "OUT_OF_TURN", "It is not your turn to bid");
    }

    if (command.bid < 0 || command.bid > round.cardsPerPlayer) {
      return fail(state, "INVALID_BID", "Bid out of range");
    }

    if (round.bids[command.actorId] !== null) {
      return fail(state, "DUPLICATE_BID", "Bid already submitted");
    }

    const forbiddenBid = getForbiddenDealerBid(round, state.players);
    if (forbiddenBid !== null && command.bid === forbiddenBid) {
      return fail(
        state,
        "COMPULSORY_BID_CONFLICT",
        "Dealer bid cannot make total bids equal cards dealt"
      );
    }

    const nextRound: RoundState = {
      ...round,
      bids: {
        ...round.bids,
        [command.actorId]: command.bid
      }
    };

    const allBidsPlaced = Object.values(nextRound.bids).every((value) => value !== null);
    if (!allBidsPlaced) {
      nextRound.bidTurnPlayerId = getNextPlayerId(state, command.actorId);
      return ok(
        {
          ...state,
          currentRound: nextRound,
          updatedAt: state.updatedAt + 1
        },
        []
      );
    }

    nextRound.bidTurnPlayerId = null;
    let nextState: GameState = {
      ...state,
      currentRound: nextRound,
      updatedAt: state.updatedAt + 1
    };

    if (nextRound.blind && !nextRound.cardsDealt) {
      nextState = dealBlindHands(nextState);
    }

    nextState = {
      ...nextState,
      phase: "trick_play",
      currentRound: {
        ...nextState.currentRound!,
        turnPlayerId: nextState.currentRound!.leadPlayerId
      },
      updatedAt: nextState.updatedAt + 1
    };

    return ok(nextState, [{ type: "bidding_complete", at: now() }]);
  }

  if (command.type === "play_card") {
    if (state.phase !== "trick_play") {
      return fail(state, "INVALID_PHASE", "Trick play is not active");
    }

    if (round.turnPlayerId !== command.actorId) {
      return fail(state, "OUT_OF_TURN", "It is not your turn to play");
    }

    const hand = round.hands[command.actorId] ?? [];
    if (!hand.includes(command.cardId)) {
      return fail(state, "CARD_NOT_IN_HAND", "Card is not in your hand");
    }

    const leadSuit = round.currentTrick[0] ? getCardSuit(round.currentTrick[0].cardId) : null;
    if (leadSuit && getCardSuit(command.cardId) !== leadSuit && hasSuit(hand, leadSuit)) {
      return fail(state, "MUST_FOLLOW_SUIT", "Player must follow the lead suit");
    }

    const nextHand = hand.filter((cardId) => cardId !== command.cardId);
    const nextRound: RoundState = {
      ...round,
      hands: {
        ...round.hands,
        [command.actorId]: nextHand
      },
      currentTrick: [...round.currentTrick, { playerId: command.actorId, cardId: command.cardId }]
    };

    if (nextRound.currentTrick.length < state.players.length) {
      nextRound.turnPlayerId = getNextPlayerId(state, command.actorId);
      return ok({ ...state, currentRound: nextRound, updatedAt: state.updatedAt + 1 }, []);
    }

    const trick = [...nextRound.currentTrick];
    const resolved = resolveTrickWinner(trick);
    const trickResult: TrickResult = {
      winnerId: resolved.winnerId,
      leadSuit: resolved.leadSuit,
      plays: trick
    };

    nextRound.tricksWon = {
      ...nextRound.tricksWon,
      [resolved.winnerId]: (nextRound.tricksWon[resolved.winnerId] ?? 0) + 1
    };
    nextRound.trickHistory = [...nextRound.trickHistory, trickResult];
    nextRound.currentTrick = [];
    nextRound.leadPlayerId = resolved.winnerId;
    nextRound.turnPlayerId = resolved.winnerId;

    const nextState: GameState = { ...state, currentRound: nextRound, updatedAt: state.updatedAt + 1 };
    const trickEvents: EngineEvent[] = [{
      type: "trick_complete",
      at: now(),
      payload: { winnerId: resolved.winnerId, trickCount: nextRound.trickHistory.length }
    }];

    if (nextRound.trickHistory.length < nextRound.cardsPerPlayer) {
      return ok(nextState, trickEvents);
    }

    const completed = completeRound(nextState);
    return ok(completed.state, [...trickEvents, ...completed.events]);
  }

  return fail(state, "UNKNOWN_COMMAND", "Unknown command");
};

export const getPublicView = (state: GameState, viewerPlayerId: string): PublicGameView => {
  const round = state.currentRound;

  const publicRound = round
    ? {
        roundIndex: round.roundIndex,
        cardsPerPlayer: round.cardsPerPlayer,
        dealerIndex: round.dealerIndex,
        blind: round.blind,
        cardsDealt: round.cardsDealt,
        bids: round.bids,
        bidTurnPlayerId: round.bidTurnPlayerId,
        tricksWon: round.tricksWon,
        leadPlayerId: round.leadPlayerId,
        turnPlayerId: round.turnPlayerId,
        currentTrick: round.currentTrick,
        trickHistory: round.trickHistory,
        handSizes: Object.fromEntries(
          Object.entries(round.hands).map(([playerId, cards]) => [playerId, cards.length])
        ),
        viewerHand: round.hands[viewerPlayerId] ?? [],
        forbiddenDealerBid: getForbiddenDealerBid(round, state.players),
        legalCardIds: (() => {
          if (state.phase !== "trick_play") {
            return [];
          }
          if (round.turnPlayerId !== viewerPlayerId) {
            return [];
          }
          const hand = round.hands[viewerPlayerId] ?? [];
          const trickLead = round.currentTrick[0] ? getCardSuit(round.currentTrick[0].cardId) : null;
          if (!trickLead || !hasSuit(hand, trickLead)) {
            return hand;
          }
          return hand.filter((cardId) => getCardSuit(cardId) === trickLead);
        })()
      }
    : null;

  return {
    gameId: state.gameId,
    players: state.players,
    phase: state.phase,
    scores: state.scores,
    roundNumber: state.roundNumber,
    currentRound: publicRound,
    completedRounds: state.completedRounds
  };
};
