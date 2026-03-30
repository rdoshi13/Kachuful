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
  it("opens how to play modal from lobby", async () => {
    render(<GameClient />);

    fireEvent.click(await screen.findByRole("button", { name: "How to Play" }));

    expect(await screen.findByText("How to Play Kachuful")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByText("How to Play Kachuful")).not.toBeInTheDocument();
    });
  });

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

  it("requests transfer code from room actions and renders it in modal", async () => {
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
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Switch device" }));

    const transferRequestEvent = lastSocket?.emitted.find(
      (entry) => entry.event === "session:transfer_request",
    );
    expect(transferRequestEvent).toBeTruthy();

    lastSocket?.trigger("session:transfer_code", {
      transferCode: "AB12CD",
      expiresAt: 1893456000000,
    });

    expect(await screen.findByText("Switch Device")).toBeInTheDocument();
    expect(await screen.findByText("Code:")).toBeInTheDocument();
    expect(await screen.findByText("AB12CD")).toBeInTheDocument();
  });

  it("redeems transfer code from lobby and restores seat session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/rooms/ROOM01/transfer")) {
          return {
            ok: true,
            json: async () => ({
              roomCode: "ROOM01",
              playerId: "p1",
              sessionToken: "new-token",
              name: "Host",
            }),
          };
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    render(<GameClient />);

    fireEvent.change(screen.getByLabelText("room-code"), {
      target: { value: "ROOM01" },
    });
    fireEvent.change(screen.getByLabelText("transfer-code"), {
      target: { value: "AB12CD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use transfer code" }));

    await screen.findByText("Room ROOM01");
    expect(lastSocket).not.toBeNull();

    const storedSession = JSON.parse(
      localStorage.getItem("kachuful:session") ?? "{}",
    );
    expect(storedSession).toMatchObject({
      roomCode: "ROOM01",
      playerId: "p1",
      sessionToken: "new-token",
      name: "Host",
    });
  });

  it("shows duplicate-name join error directly in lobby", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error: "Name is already in use",
        }),
      })),
    );

    render(<GameClient />);

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "Guest" },
    });
    fireEvent.change(screen.getByLabelText("room-code"), {
      target: { value: "ROOM01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join room" }));

    expect(
      await screen.findByText(
        "That name is already taken in this room. Please choose a different name.",
      ),
    ).toBeInTheDocument();
  });

  it("shows host-offline join error directly in lobby", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({
          error: "Host is offline",
        }),
      })),
    );

    render(<GameClient />);

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "Guest" },
    });
    fireEvent.change(screen.getByLabelText("room-code"), {
      target: { value: "ROOM01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join room" }));

    expect(
      await screen.findByText(
        "Host is offline right now. You can join once the host comes back online.",
      ),
    ).toBeInTheDocument();
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

  it("toggles room details from the room header dropdown", async () => {
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
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
      ],
    });

    const roomInfoButton = await screen.findByRole("button", {
      name: /Room info/i,
    });
    expect(await screen.findByRole("button", { name: "How to Play" })).toBeInTheDocument();
    expect(await screen.findByText(/Lobby open/)).toBeInTheDocument();

    fireEvent.click(roomInfoButton);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "How to Play" })).toBeNull();
    });
    expect(screen.queryByText(/Lobby open/)).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /Room info/i }));
    expect(await screen.findByRole("button", { name: "How to Play" })).toBeInTheDocument();
    expect(await screen.findByText(/Lobby open/)).toBeInTheDocument();
  });

  it("copies room code to clipboard from room header button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

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

    fireEvent.click(await screen.findByRole("button", { name: "Copy room code" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("ROOM01");
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("shows host end game button during active game and emits game:end", async () => {
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
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p1",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 0, p2: 0 },
        viewerHand: [],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "End game" }));
    const endEvent = lastSocket?.emitted.find((entry) => entry.event === "game:end");
    expect(endEvent).toBeTruthy();
  });

  it("maps host-offline socket errors to friendly copy", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p2",
        sessionToken: "token-2",
        name: "Guest",
      }),
    );

    render(<GameClient />);

    await waitFor(() => expect(lastSocket).not.toBeNull());
    lastSocket?.trigger("game:error", {
      code: "AUTH_FAILED",
      message: "Host is offline",
    });

    expect(
      await screen.findByText(
        "Host is offline right now. You can join once the host comes back online.",
      ),
    ).toBeInTheDocument();
  });

  it("shows host lock toggle and emits room:lock_toggle", async () => {
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
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
      ],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Lock room" }));
    const lockEvent = lastSocket?.emitted.find((entry) => entry.event === "room:lock_toggle");
    expect(lockEvent?.payload).toEqual({ locked: true });

    lastSocket?.trigger("room:state", {
      roomCode: "ROOM01",
      hostPlayerId: "p1",
      locked: true,
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
      ],
    });

    expect(await screen.findByRole("button", { name: "Unlock room" })).toBeInTheDocument();
  });

  it("shows remind button for current-turn player and emits turn:poke", async () => {
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
      roundNumber: 0,
      completedRounds: [],
      currentRound: {
        roundIndex: 0,
        cardsPerPlayer: 1,
        trumpSuit: "S",
        dealerIndex: 0,
        blind: true,
        cardsDealt: false,
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p2",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 0, p2: 0 },
        viewerHand: [],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Remind Guest" }));
    const pokeEvent = lastSocket?.emitted.find((entry) => entry.event === "turn:poke");
    expect(pokeEvent?.payload).toEqual({ targetPlayerId: "p2" });
  });

  it("pulses turn banner when the player is poked", async () => {
    localStorage.setItem(
      "kachuful:session",
      JSON.stringify({
        roomCode: "ROOM01",
        playerId: "p2",
        sessionToken: "token-2",
        name: "Guest",
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
      roundNumber: 0,
      completedRounds: [],
      currentRound: {
        roundIndex: 0,
        cardsPerPlayer: 1,
        trumpSuit: "S",
        dealerIndex: 0,
        blind: true,
        cardsDealt: false,
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p2",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 0, p2: 0 },
        viewerHand: [],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    const banner = await screen.findByRole("status");
    expect(banner).not.toHaveClass("turn-banner--poked");

    lastSocket?.trigger("turn:poked", {
      targetPlayerId: "p2",
      byPlayerId: "p1",
      at: Date.now(),
    });

    expect(await screen.findByRole("status")).toHaveClass("turn-banner--poked");
  });

  it("shows spectator label for players not in current active game", async () => {
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
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: true },
        { playerId: "p3", name: "Spectator", connected: true },
      ],
    });
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
        bids: { p1: 0, p2: 1 },
        bidTurnPlayerId: null,
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 1, p2: 1 },
        viewerHand: [],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    expect(await screen.findByText("spectator")).toBeInTheDocument();
  });

  it("renders online/offline status dots", async () => {
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
      players: [
        { playerId: "p1", name: "Host", connected: true },
        { playerId: "p2", name: "Guest", connected: false },
      ],
    });

    const offlineDot = await screen.findByLabelText("Guest offline");
    const onlineDot = await screen.findByLabelText("Host online");
    expect(offlineDot).toHaveClass("status-dot", "status-dot--offline");
    expect(onlineDot).toHaveClass("status-dot", "status-dot--online");
  });

  it("opens and closes how to play modal with rules and app controls", async () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "How to Play" }));

    expect(await screen.findByText("How to Play Kachuful")).toBeInTheDocument();
    expect(await screen.findByText("Round Flow")).toBeInTheDocument();
    expect(await screen.findByText("Winning & Scoring")).toBeInTheDocument();
    expect(await screen.findByText("Buttons & Controls")).toBeInTheDocument();
    expect(await screen.findByText("You must follow lead suit whenever possible.")).toBeInTheDocument();
    expect(await screen.findByText("Host only; requires at least 2 online players.")).toBeInTheDocument();
    expect(await screen.findByText("Sort cards with trump suit first.")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText("How to Play Kachuful")).not.toBeInTheDocument();
    });
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

    expect(await screen.findByText("Your turn")).toBeInTheDocument();
    expect(await screen.findByText("Place your bid.")).toBeInTheDocument();
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

  it("resets ordered hand preference when a new round starts", async () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "Order hand" }));

    const orderedRoundOne = Array.from(
      document.querySelectorAll("button.card-button"),
    ).map((element) => element.getAttribute("aria-label"));
    expect(orderedRoundOne).toEqual(["AD", "2D", "5S", "KH", "3C"]);

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "bidding",
      scores: { p1: 11, p2: 0 },
      roundNumber: 2,
      completedRounds: [
        {
          roundIndex: 1,
          cardsPerPlayer: 5,
          trumpSuit: "D",
          bids: { p1: 2, p2: 2 },
          tricksWon: { p1: 2, p2: 3 },
          scoreDelta: { p1: 12, p2: 0 },
        },
      ],
      currentRound: {
        roundIndex: 2,
        cardsPerPlayer: 3,
        trumpSuit: "H",
        dealerIndex: 0,
        blind: false,
        cardsDealt: true,
        bids: { p1: null, p2: null },
        bidTurnPlayerId: "p2",
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 3, p2: 3 },
        viewerHand: ["4C", "2H", "AS"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    await screen.findByRole("button", { name: "4C" });

    const roundTwoCards = Array.from(
      document.querySelectorAll("button.card-button"),
    ).map((element) => element.getAttribute("aria-label"));
    expect(roundTwoCards).toEqual(["4C", "2H", "AS"]);
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
    expect(await screen.findByText("Current turn")).toBeInTheDocument();
    expect(await screen.findByText("Guest is up.")).toBeInTheDocument();
    expect(await screen.findByText("Bid: 1")).toBeInTheDocument();
    expect(await screen.findByText("Won: 1")).toBeInTheDocument();
    const hostWinningButton = await screen.findByRole("button", {
      name: "View winning tricks for Host",
    });
    const hostRow = hostWinningButton.closest(".round-stats__row");
    expect(hostRow).not.toHaveClass("round-stats__row--self");
    expect(hostRow).toHaveTextContent("Hands needed: On target");
    expect(await screen.findByText("Playing now")).toBeInTheDocument();
    const guestWinningButton = await screen.findByRole("button", {
      name: "View winning tricks for Guest",
    });
    const guestRow = guestWinningButton.closest(".round-stats__row");
    expect(guestRow).toHaveClass("round-stats__row--active-turn");

    fireEvent.click(
      hostWinningButton,
    );

    const winningTricksDialog = await screen.findByRole("dialog");
    expect(winningTricksDialog).toBeInTheDocument();
    expect(await screen.findByText("Host winning tricks")).toBeInTheDocument();
    expect(await screen.findByText("Trick 1")).toBeInTheDocument();
    expect(
      winningTricksDialog.querySelectorAll(".trick-card--winner"),
    ).toHaveLength(1);
  });

  it("highlights the current leading card on table and updates as trick changes", async () => {
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
        { playerId: "p3", name: "Third" },
      ],
      phase: "trick_play",
      scores: { p1: 0, p2: 0, p3: 0 },
      roundNumber: 1,
      completedRounds: [],
      currentRound: {
        roundIndex: 1,
        cardsPerPlayer: 3,
        trumpSuit: "S",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: 1, p2: 1, p3: 1 },
        bidTurnPlayerId: null,
        tricksWon: { p1: 0, p2: 0, p3: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p3",
        currentTrick: [
          { playerId: "p1", cardId: "KH" },
          { playerId: "p2", cardId: "2H" },
        ],
        trickHistory: [],
        handSizes: { p1: 2, p2: 2, p3: 2 },
        viewerHand: ["3C", "4D"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    expect(await screen.findByText("Cards on table")).toBeInTheDocument();
    expect(document.querySelectorAll(".trick-card--winner")).toHaveLength(1);
    expect(
      document.querySelector(".trick-card--winner .trick-card__player")?.textContent,
    ).toBe("Host");

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
        { playerId: "p3", name: "Third" },
      ],
      phase: "trick_play",
      scores: { p1: 0, p2: 0, p3: 0 },
      roundNumber: 1,
      completedRounds: [],
      currentRound: {
        roundIndex: 1,
        cardsPerPlayer: 3,
        trumpSuit: "S",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: 1, p2: 1, p3: 1 },
        bidTurnPlayerId: null,
        tricksWon: { p1: 0, p2: 0, p3: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [
          { playerId: "p1", cardId: "KH" },
          { playerId: "p2", cardId: "2H" },
          { playerId: "p3", cardId: "3S" },
        ],
        trickHistory: [],
        handSizes: { p1: 2, p2: 2, p3: 2 },
        viewerHand: ["3C", "4D"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    await waitFor(() => {
      expect(
        document.querySelector(".trick-card--winner .trick-card__player")
          ?.textContent,
      ).toBe("Third");
    });
  });

  it("shows last trick for 2 seconds across round transition and highlights winner", async () => {
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
        { playerId: "p3", name: "Third" },
      ],
      phase: "bidding",
      scores: { p1: 11, p2: 0, p3: 0 },
      roundNumber: 3,
      completedRounds: [],
      currentRound: {
        roundIndex: 3,
        cardsPerPlayer: 2,
        trumpSuit: "S",
        dealerIndex: 1,
        blind: false,
        cardsDealt: true,
        bids: { p1: null, p2: 1, p3: 0 },
        bidTurnPlayerId: "p1",
        tricksWon: { p1: 0, p2: 0, p3: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 2, p2: 2, p3: 2 },
        viewerHand: ["5S", "7D"],
        forbiddenDealerBid: null,
        legalCardIds: [],
      },
    });

    expect(screen.queryByText("Cards on table")).not.toBeInTheDocument();

    lastSocket?.trigger("game:trick_reveal", {
      winnerId: "p3",
      winnerCardId: "2H",
      trickCount: 3,
      roundIndex: 2,
      plays: [
        { playerId: "p1", cardId: "3H" },
        { playerId: "p2", cardId: "4H" },
        { playerId: "p3", cardId: "2H" },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText("Cards on table")).toBeInTheDocument();
      expect(document.querySelectorAll(".trick-card")).toHaveLength(3);
    });
    expect(document.querySelectorAll(".trick-card--winner")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Bid 0" })).not.toBeInTheDocument();

    await new Promise((resolve) => {
      setTimeout(resolve, 2100);
    });
    await waitFor(() => {
      expect(document.querySelectorAll(".trick-card")).toHaveLength(0);
    });
    expect(await screen.findByRole("button", { name: "Bid 0" })).toBeInTheDocument();
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
    expect(
      await screen.findByText((_, element) =>
        element?.textContent?.trim() === "Spades (♠)",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText((_, element) =>
        element?.textContent?.trim() === "Diamonds (♦)",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("+11")).toBeInTheDocument();
    expect(await screen.findByLabelText("Miss")).toBeInTheDocument();
  });

  it("auto-opens round summary when a round completes and game continues", async () => {
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
        bids: { p1: 1, p2: 0 },
        bidTurnPlayerId: null,
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p1",
        turnPlayerId: "p1",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 1, p2: 1 },
        viewerHand: ["AS"],
        forbiddenDealerBid: null,
        legalCardIds: ["AS"],
      },
    });

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "bidding",
      scores: { p1: 11, p2: 0 },
      roundNumber: 1,
      completedRounds: [
        {
          roundIndex: 0,
          cardsPerPlayer: 1,
          trumpSuit: "S",
          bids: { p1: 1, p2: 0 },
          tricksWon: { p1: 1, p2: 0 },
          scoreDelta: { p1: 11, p2: 0 },
        },
      ],
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

    expect(screen.queryByText("Round 1 Summary")).not.toBeInTheDocument();

    await new Promise((resolve) => {
      setTimeout(resolve, 2100);
    });

    expect(await screen.findByText("Round 1 Summary")).toBeInTheDocument();
    expect(
      await screen.findByText((_, element) =>
        element?.textContent?.replace(/\s+/g, " ").trim() ===
        "Cards: 1 | Trump: Spades (♠)",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("Total")).toBeInTheDocument();
    expect(await screen.findByText("Round Points")).toBeInTheDocument();
    expect(await screen.findByText("+11")).toBeInTheDocument();
  });

  it("does not auto-open round summary when game reaches final game_complete phase", async () => {
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
      scores: { p1: 80, p2: 72 },
      roundNumber: 14,
      completedRounds: [],
      currentRound: {
        roundIndex: 14,
        cardsPerPlayer: 1,
        trumpSuit: "C",
        dealerIndex: 0,
        blind: false,
        cardsDealt: true,
        bids: { p1: 0, p2: 1 },
        bidTurnPlayerId: null,
        tricksWon: { p1: 0, p2: 0 },
        leadPlayerId: "p2",
        turnPlayerId: "p2",
        currentTrick: [],
        trickHistory: [],
        handSizes: { p1: 1, p2: 1 },
        viewerHand: ["3C"],
        forbiddenDealerBid: null,
        legalCardIds: ["3C"],
      },
    });

    lastSocket?.trigger("game:state", {
      gameId: "ROOM01",
      players: [
        { playerId: "p1", name: "Host" },
        { playerId: "p2", name: "Guest" },
      ],
      phase: "game_complete",
      scores: { p1: 91, p2: 72 },
      roundNumber: 14,
      completedRounds: [
        {
          roundIndex: 14,
          cardsPerPlayer: 1,
          trumpSuit: "C",
          bids: { p1: 0, p2: 1 },
          tricksWon: { p1: 0, p2: 1 },
          scoreDelta: { p1: 0, p2: 11 },
        },
      ],
      currentRound: null,
    });

    expect(await screen.findByText("Game Complete")).toBeInTheDocument();
    expect(screen.queryByText("Round 15 Summary")).not.toBeInTheDocument();
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
