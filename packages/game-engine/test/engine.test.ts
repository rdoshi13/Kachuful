import { describe, expect, it } from "vitest";
import {
  ROUND_PATTERN,
  TRUMP_SUIT_ORDER,
  type CardId,
  type Command,
  type GameState,
  type PlayerRef,
  type RoundState
} from "@kachuful/shared-types";
import { applyCommand, createGame, getPublicView } from "../src/index.js";

const players: PlayerRef[] = [
  { playerId: "p1", name: "Aarav" },
  { playerId: "p2", name: "Bhavya" },
  { playerId: "p3", name: "Charu" }
];

const expectOk = (state: GameState, command: Command): GameState => {
  const result = applyCommand(state, command);
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.state;
};

const startGame = (seed = 42): GameState =>
  expectOk(
    createGame({ gameId: "g1", players, seed }),
    { type: "start_game", actorId: "p1" }
  );

const playFirstLegalCard = (state: GameState): GameState => {
  const round = state.currentRound;
  if (!round?.turnPlayerId) {
    throw new Error("No active turn player");
  }
  const view = getPublicView(state, round.turnPlayerId);
  const cardId = view.currentRound?.legalCardIds[0];
  if (!cardId) {
    throw new Error("No legal card to play");
  }
  return expectOk(state, { type: "play_card", actorId: round.turnPlayerId, cardId });
};

const submitAutoBid = (state: GameState): GameState => {
  const round = state.currentRound;
  if (!round?.bidTurnPlayerId) {
    throw new Error("No bidding turn");
  }

  const playerId = round.bidTurnPlayerId;
  const view = getPublicView(state, playerId);
  const cardsPerPlayer = view.currentRound?.cardsPerPlayer ?? 0;
  const forbidden = view.currentRound?.forbiddenDealerBid;

  let bid = 0;
  if (forbidden !== null && forbidden !== undefined) {
    bid = forbidden === 0 ? 1 : 0;
  }

  bid = Math.min(bid, cardsPerPlayer);

  return expectOk(state, {
    type: "submit_bid",
    actorId: playerId,
    bid
  });
};

const autoplayToCompletion = (seed = 777): { finalState: GameState; commands: Command[] } => {
  let state = createGame({ gameId: "g-auto", players, seed });
  const commands: Command[] = [{ type: "start_game", actorId: "p1" }];
  state = expectOk(state, commands[0]!);

  let safetyCounter = 0;
  while (state.phase !== "game_complete") {
    safetyCounter += 1;
    if (safetyCounter > 5000) {
      throw new Error("Autoplay safety limit reached");
    }

    if (state.phase === "bidding") {
      const round = state.currentRound;
      if (!round?.bidTurnPlayerId) {
        throw new Error("Expected bidding turn player");
      }
      const view = getPublicView(state, round.bidTurnPlayerId);
      const forbidden = view.currentRound?.forbiddenDealerBid;
      let bid = 0;
      if (forbidden !== null && forbidden !== undefined) {
        bid = forbidden === 0 ? 1 : 0;
      }
      const command: Command = {
        type: "submit_bid",
        actorId: round.bidTurnPlayerId,
        bid
      };
      commands.push(command);
      state = expectOk(state, command);
      continue;
    }

    if (state.phase === "trick_play") {
      const round = state.currentRound;
      if (!round?.turnPlayerId) {
        throw new Error("Expected trick turn player");
      }
      const view = getPublicView(state, round.turnPlayerId);
      const cardId = view.currentRound?.legalCardIds[0];
      if (!cardId) {
        throw new Error("No legal card available for autoplay");
      }
      const command: Command = {
        type: "play_card",
        actorId: round.turnPlayerId,
        cardId
      };
      commands.push(command);
      state = expectOk(state, command);
      continue;
    }

    throw new Error(`Unexpected phase ${state.phase}`);
  }

  return { finalState: state, commands };
};

const controlledRound = (): RoundState => ({
  roundIndex: 0,
  cardsPerPlayer: 1,
  trumpSuit: "S",
  dealerIndex: 0,
  blind: false,
  cardsDealt: true,
  drawPile: [],
  bids: { p1: 0, p2: 0, p3: 0 },
  bidTurnPlayerId: null,
  tricksWon: { p1: 0, p2: 0, p3: 0 },
  hands: { p1: [], p2: [], p3: [] },
  leadPlayerId: "p1",
  turnPlayerId: "p1",
  currentTrick: [],
  trickHistory: []
});

describe("game engine", () => {
  it("follows round progression 1..8..1", () => {
    const { finalState } = autoplayToCompletion(1337);
    const sequence = finalState.completedRounds.map((round) => round.cardsPerPlayer);
    expect(sequence).toEqual([...ROUND_PATTERN]);
  });

  it("assigns trump suit in S->D->C->H order by round", () => {
    const { finalState } = autoplayToCompletion(1337);
    const trumpSequence = finalState.completedRounds.map((round) => round.trumpSuit);
    const expected = ROUND_PATTERN.map((_, roundIndex) => TRUMP_SUIT_ORDER[roundIndex % TRUMP_SUIT_ORDER.length]);
    expect(trumpSequence).toEqual(expected);
  });

  it("enforces compulsory dealer bid restriction", () => {
    let state = startGame(101);

    state = expectOk(state, { type: "submit_bid", actorId: "p2", bid: 1 });
    state = expectOk(state, { type: "submit_bid", actorId: "p3", bid: 0 });

    const result = applyCommand(state, { type: "submit_bid", actorId: "p1", bid: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("COMPULSORY_BID_CONFLICT");
    }
  });

  it("deals blind round cards only after bids are complete", () => {
    let state = startGame(202);
    const round = state.currentRound;

    expect(round?.blind).toBe(true);
    expect(round?.cardsDealt).toBe(false);
    expect(Object.values(round?.hands ?? {}).every((cards) => cards.length === 0)).toBe(true);

    state = expectOk(state, { type: "submit_bid", actorId: "p2", bid: 0 });
    state = expectOk(state, { type: "submit_bid", actorId: "p3", bid: 0 });
    state = expectOk(state, { type: "submit_bid", actorId: "p1", bid: 0 });

    expect(state.phase).toBe("trick_play");
    expect(state.currentRound?.cardsDealt).toBe(true);
    expect(Object.values(state.currentRound?.hands ?? {}).every((cards) => cards.length === 1)).toBe(true);
  });

  it("rejects off-suit play when player can follow suit", () => {
    const state = createGame({ gameId: "g-follow", players, seed: 9 });
    const customState: GameState = {
      ...state,
      phase: "trick_play",
      roundNumber: 0,
      currentRound: {
        ...controlledRound(),
        hands: {
          p1: [],
          p2: ["3H", "4C"],
          p3: ["5D"]
        },
        currentTrick: [{ playerId: "p1", cardId: "2H" }],
        turnPlayerId: "p2"
      }
    };

    const result = applyCommand(customState, {
      type: "play_card",
      actorId: "p2",
      cardId: "4C"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MUST_FOLLOW_SUIT");
    }
  });

  it("resolves trick winner by highest lead suit when no trump is played", () => {
    const state = createGame({ gameId: "g-trick", players, seed: 5 });
    const customState: GameState = {
      ...state,
      phase: "trick_play",
      roundNumber: 0,
      currentRound: {
        ...controlledRound(),
        hands: {
          p1: [],
          p2: ["KH"],
          p3: ["3D"]
        },
        bids: { p1: 0, p2: 1, p3: 0 },
        currentTrick: [{ playerId: "p1", cardId: "2H" }],
        turnPlayerId: "p2"
      }
    };

    const afterP2 = expectOk(customState, {
      type: "play_card",
      actorId: "p2",
      cardId: "KH"
    });

    const afterP3 = expectOk(afterP2, {
      type: "play_card",
      actorId: "p3",
      cardId: "3D"
    });

    const summary = afterP3.completedRounds[0];
    expect(summary?.tricksWon.p2).toBe(1);
  });

  it("lets trump beat higher lead-suit cards", () => {
    const state = createGame({ gameId: "g-trump", players, seed: 5 });
    const customState: GameState = {
      ...state,
      phase: "trick_play",
      roundNumber: 0,
      currentRound: {
        ...controlledRound(),
        hands: {
          p1: [],
          p2: ["KH"],
          p3: ["3S"]
        },
        bids: { p1: 0, p2: 0, p3: 1 },
        currentTrick: [{ playerId: "p1", cardId: "AH" }],
        turnPlayerId: "p2"
      }
    };

    const afterP2 = expectOk(customState, {
      type: "play_card",
      actorId: "p2",
      cardId: "KH"
    });

    const afterP3 = expectOk(afterP2, {
      type: "play_card",
      actorId: "p3",
      cardId: "3S"
    });

    const summary = afterP3.completedRounds[0];
    expect(summary?.tricksWon.p3).toBe(1);
  });

  it("resolves between trump cards by highest trump rank", () => {
    const state = createGame({ gameId: "g-trump-high", players, seed: 5 });
    const customState: GameState = {
      ...state,
      phase: "trick_play",
      roundNumber: 0,
      currentRound: {
        ...controlledRound(),
        hands: {
          p1: [],
          p2: ["3S"],
          p3: ["AS"]
        },
        bids: { p1: 0, p2: 0, p3: 1 },
        currentTrick: [{ playerId: "p1", cardId: "2H" }],
        turnPlayerId: "p2"
      }
    };

    const afterP2 = expectOk(customState, {
      type: "play_card",
      actorId: "p2",
      cardId: "3S"
    });

    const afterP3 = expectOk(afterP2, {
      type: "play_card",
      actorId: "p3",
      cardId: "AS"
    });

    const summary = afterP3.completedRounds[0];
    expect(summary?.tricksWon.p3).toBe(1);
  });

  it("is deterministic for identical command streams", () => {
    const { finalState, commands } = autoplayToCompletion(9001);

    let replay = createGame({ gameId: "g-auto", players, seed: 9001 });
    for (const command of commands) {
      replay = expectOk(replay, command);
    }

    expect(replay).toEqual(finalState);
  });

  it("rejects invalid phase, unknown player, and out-of-turn commands", () => {
    const lobbyState = createGame({ gameId: "g-invalid", players, seed: 10 });
    const unknown = applyCommand(lobbyState, { type: "start_game", actorId: "ghost" });
    expect(unknown.ok).toBe(false);

    let state = startGame(10);

    const badPhase = applyCommand(state, { type: "play_card", actorId: "p2", cardId: "2C" as CardId });
    expect(badPhase.ok).toBe(false);

    const outOfTurn = applyCommand(state, { type: "submit_bid", actorId: "p1", bid: 0 });
    expect(outOfTurn.ok).toBe(false);

    state = submitAutoBid(state);
    state = submitAutoBid(state);
    state = submitAutoBid(state);
    state = playFirstLegalCard(state);

    expect(state.phase).toBe("trick_play");
  });
});
