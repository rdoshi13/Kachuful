import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { GameClient } from "../components/GameClient";

class FakeSocket {
  handlers = new Map<string, Array<(payload: any) => void>>();
  emitted: Array<{ event: string; payload: any }> = [];

  on(event: string, handler: (payload: any) => void) {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
    return this;
  }

  emit(event: string, payload?: any) {
    this.emitted.push({ event, payload });
    return true;
  }

  disconnect() {
    return true;
  }

  trigger(event: string, payload?: any) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.forEach((handler) => handler(payload));
  }
}

let lastSocket: FakeSocket | null = null;

vi.mock("../lib/socket", () => ({
  createGameSocket: () => {
    lastSocket = new FakeSocket();
    return lastSocket;
  },
  __getLastSocket: () => lastSocket,
}));

beforeEach(() => {
  localStorage.clear();
  lastSocket = null;
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("GameClient", () => {
  it("creates room and joins socket with saved session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          roomCode: "ROOM01",
          playerId: "p1",
          sessionToken: "token-1",
        }),
      })),
    );

    render(<GameClient />);

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "Host" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create room" }));

    await screen.findByText("Room ROOM01");

    const socket = lastSocket;
    expect(socket).not.toBeNull();
    socket?.trigger("connect");

    const joinEvent = socket?.emitted.find(
      (entry) => entry.event === "room:join",
    );
    expect(joinEvent?.payload).toMatchObject({
      roomCode: "ROOM01",
      playerId: "p1",
      sessionToken: "token-1",
    });
  });

  it("shows start game only when at least two players are in the room", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("room:state", {
      roomCode: "ROOM01",
      hostPlayerId: "p1",
      locked: false,
      players: [{ playerId: "p1", name: "Host", connected: true }],
    });

    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();

    lastSocket?.trigger("room:state", {
      roomCode: "ROOM01",
      hostPlayerId: "p1",
      locked: false,
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
      ],
    });

    expect(await screen.findByRole("button", { name: "Start game" })).toBeInTheDocument();
  });

  it("disables compulsory dealer bid in bidding UI", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("room:state", {
      roomCode: "ROOM01",
      hostPlayerId: "p1",
      locked: true,
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
      ],
    });

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "bidding",
      scores: { p1: 0, p2: 0 },
      roundNumber: 0,
      completedRounds: [],
      currentRound: {
        roundIndex: 0,
        cardsPerPlayer: 1,
        trumpSuit: "S",
        dealerIndex: 0,
        blind: true,
        cardsDealt: false,
        bids: { p1: null, p2: 0 },
        bidTurnPlayerId: "p1",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 0, p2: 0 },
        viewerHand: [],
        forbiddenDealerBid: 1,
        legalCardIds: [],
      },
    });

    expect(await screen.findByRole("button", { name: "Bid 0" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "Bid 1" })).toBeDisabled();
  });

  it("enables only legal cards during trick play", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "trick_play",
      scores: { p1: 0, p2: 0 },
      roundNumber: 0,
      completedRounds: [],
      currentRound: {
        roundIndex: 0,
        cardsPerPlayer: 1,
        trumpSuit: "S",
        dealerIndex: 0,
        blind: false,
        cardsDealt: true,
        bids: { p1: 0, p2: 0 },
        bidTurnPlayerId: null,
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [{ playerId: "p2", cardId: "2H" }],
        trickHistory: [],
        handSizes: { p1: 2, p2: 1 },
        viewerHand: ["3H", "4C"],
        forbiddenDealerBid: null,
        legalCardIds: ["3H"],
      },
    });

    expect(await screen.findByRole("button", { name: "3H" })).toBeEnabled();
    expect(await screen.findByRole("button", { name: "4C" })).toBeDisabled();
  });

  it("shows dealt hand during non-blind bidding", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "bidding",
      scores: { p1: 0, p2: 0 },
      roundNumber: 1,
      completedRounds: [],
      currentRound: {
        roundIndex: 1,
        cardsPerPlayer: 2,
        trumpSuit: "D",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p1",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 2, p2: 2 },
        viewerHand: ["3H", "4C"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    expect(await screen.findByRole("button", { name: "3H" })).toBeDisabled();
    expect(await screen.findByRole("button", { name: "4C" })).toBeDisabled();
  });

  it("orders hand with trump-first suit grouping when requested", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "bidding",
      scores: { p1: 0, p2: 0 },
      roundNumber: 1,
      completedRounds: [],
      currentRound: {
        roundIndex: 1,
        cardsPerPlayer: 5,
        trumpSuit: "D",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p1",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 5, p2: 5 },
        viewerHand: ["3C", "2D", "5S", "KH", "AD"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    await screen.findByRole("button", { name: "3C" });

    const initialOrder = Array.from(document.querySelectorAll("button.card-button")).map(
      (element) => element.getAttribute("aria-label"),
    );
    expect(initialOrder).toEqual(["3C", "2D", "5S", "KH", "AD"]);

    fireEvent.click(await screen.findByRole("button", { name: "Order hand" }));

    const orderedCards = Array.from(document.querySelectorAll("button.card-button")).map(
      (element) => element.getAttribute("aria-label"),
    );
    expect(orderedCards).toEqual(["AD", "2D", "5S", "KH", "3C"]);
  });

  it("shows round tracker and opens winning tricks modal", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "trick_play",
      scores: { p1: 0, p2: 0 },
      roundNumber: 1,
      completedRounds: [],
      currentRound: {
        roundIndex: 1,
        cardsPerPlayer: 2,
        trumpSuit: "D",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: 1, p2: 0 },
        bidTurnPlayerId: null,
        tricksWon: { p1: 1, p2: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [
          {
            winnerId: "p1",
            leadSuit: "H",
            plays: [
              { playerId: "p1", cardId: "KH" },
              { playerId: "p2", cardId: "2H" },
            ],
          },
        ],
        handSizes: { p1: 1, p2: 1 },
        viewerHand: ["3C"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    expect(await screen.findByText("Round Tracker")).toBeInTheDocument();
    expect(await screen.findByText("Bid: 1")).toBeInTheDocument();
    expect(await screen.findByText("Won: 1")).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View winning tricks for Host",
      }),
    );

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByText("Host winning tricks")).toBeInTheDocument();
    expect(await screen.findByText("Trick 1")).toBeInTheDocument();
  });

  it("shows trump suit label, trump preview, and cards-per-round info", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "bidding",
      scores: { p1: 0, p2: 0 },
      roundNumber: 1,
      completedRounds: [],
      currentRound: {
        roundIndex: 1,
        cardsPerPlayer: 2,
        trumpSuit: "D",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p1",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 2, p2: 2 },
        viewerHand: ["3H", "4C"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    expect(await screen.findByText("Round Info")).toBeInTheDocument();
    expect(await screen.findByText("No. of cards:")).toBeInTheDocument();
    expect(await screen.findByText("Trump:")).toBeInTheDocument();
    expect(await screen.findByText("Diamonds")).toBeInTheDocument();
    expect(
      await screen.findByLabelText("Trump preview AD"),
    ).toBeInTheDocument();
  });

  it("opens per-player round summary on demand", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "bidding",
      scores: { p1: 11, p2: 10 },
      roundNumber: 2,
      completedRounds: [
        {
          roundIndex: 0,
          cardsPerPlayer: 1,
          trumpSuit: "S",
          bids: { p1: 1, p2: 1 },
          tricksWon: { p1: 1, p2: 0 },
          scoreDelta: { p1: 11, p2: 0 },
        },
        {
          roundIndex: 1,
          cardsPerPlayer: 2,
          trumpSuit: "D",
          bids: { p1: 0, p2: 1 },
          tricksWon: { p1: 2, p2: 0 },
          scoreDelta: { p1: 0, p2: 10 },
        },
      ],
      currentRound: {
        roundIndex: 2,
        cardsPerPlayer: 3,
        trumpSuit: "C",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p1",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 3, p2: 3 },
        viewerHand: ["3H", "4C", "5S"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "View round summary for Host",
      }),
    );

    expect(await screen.findByText("Host Round-by-Round Summary")).toBeInTheDocument();
    expect(await screen.findByText("Round Points")).toBeInTheDocument();
    expect(await screen.findByText("Spades")).toBeInTheDocument();
    expect(await screen.findByText("Diamonds")).toBeInTheDocument();
    expect(await screen.findByText("+11")).toBeInTheDocument();
    expect(await screen.findByText("Miss")).toBeInTheDocument();
  });

  it("shows game complete panel with winners and round breakdown", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p1",
        sessionToken: "token-1",
        name: "Host",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("connect");
    lastSocket?.trigger("room:state", {
      roomCode: "ROOM01",
      hostPlayerId: "p1",
      locked: true,
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
      ],
    });

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "game_complete",
      scores: { p1: 33, p2: 10 },
      roundNumber: 14,
      completedRounds: [
        {
          roundIndex: 0,
          cardsPerPlayer: 1,
          trumpSuit: "S",
          bids: { p1: 1, p2: 0 },
          tricksWon: { p1: 1, p2: 0 },
          scoreDelta: { p1: 11, p2: 10 },
        },
      ],
      currentRound: null,
    });

    expect(await screen.findByText("Game Complete")).toBeInTheDocument();
    expect(await screen.findByText("Winner: Host (33 points)")).toBeInTheDocument();
    expect(await screen.findByText("Final Standings")).toBeInTheDocument();
    expect(await screen.findByText("Round-by-Round Breakdown")).toBeInTheDocument();
    expect(await screen.findByText("Spades")).toBeInTheDocument();
    expect(await screen.findByText("1/1 (+11)")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Start New Game" }));
    const restartEvent = lastSocket?.emitted.find((entry) => entry.event === "game:restart");
    expect(restartEvent).toBeTruthy();
  });
});
