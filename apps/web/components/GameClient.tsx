"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  PublicGameView,
  RoundSummary,
  RoomStatePayload,
  Suit,
  TrickPlay,
} from "@kachuful/shared-types";
import { createRoom, joinRoom } from "../lib/api";
import {
  clearSession,
  loadSession,
  saveSession,
  type StoredSession,
} from "../lib/session";
import { createGameSocket, type GameSocket } from "../lib/socket";
import { PlayingCard } from "./PlayingCard";

const bidValues = (max: number): number[] =>
  Array.from({ length: max + 1 }, (_, index) => index);
const TRICK_REVEAL_DURATION_MS = 2000;
const AUTO_SUMMARY_DELAY_MS = 2000;
const TRUMP_SUIT_LABEL: Record<Suit, string> = {
  S: "Spades",
  D: "Diamonds",
  C: "Clubs",
  H: "Hearts",
};
const SUIT_SYMBOL: Record<Suit, string> = {
  S: "♠",
  D: "♦",
  C: "♣",
  H: "♥",
};
const BASE_HAND_SUIT_ORDER: Suit[] = ["S", "H", "C", "D"];
const RANK_VALUE: Record<string, number> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const sortHandCards = (cardIds: string[], trumpSuit: Suit | null): string[] => {
  const suitOrder = trumpSuit
    ? [trumpSuit, ...BASE_HAND_SUIT_ORDER.filter((suit) => suit !== trumpSuit)]
    : BASE_HAND_SUIT_ORDER;

  return [...cardIds].sort((left, right) => {
    const leftSuit = left.slice(-1) as Suit;
    const rightSuit = right.slice(-1) as Suit;
    const suitOrderDelta =
      suitOrder.indexOf(leftSuit) - suitOrder.indexOf(rightSuit);
    if (suitOrderDelta !== 0) {
      return suitOrderDelta;
    }

    const leftRank = RANK_VALUE[left.slice(0, -1)] ?? 0;
    const rightRank = RANK_VALUE[right.slice(0, -1)] ?? 0;
    return rightRank - leftRank;
  });
};

interface TrickRevealState {
  plays: TrickPlay[];
  winnerId: string;
}

interface HeroChip {
  id: string;
  label: string;
  tone: "accent" | "neutral";
}

const HERO_PRIMARY_CHIPS: HeroChip[] = [
  { id: "no-signup", label: "No signup", tone: "accent" },
  { id: "private", label: "Private rooms", tone: "accent" },
  { id: "rejoin", label: "Rejoin quickly", tone: "neutral" },
  { id: "realtime", label: "Realtime play", tone: "neutral" },
];

const HERO_EXTRA_CHIPS: HeroChip[] = [
  { id: "remote", label: "Remote game nights", tone: "neutral" },
  { id: "cross-country", label: "Cross-country play", tone: "neutral" },
];

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const parseTrickRevealPayload = (value: unknown): TrickRevealState | null => {
  const payload = asObject(value);
  if (!payload) {
    return null;
  }

  const winnerId = payload.winnerId;
  const plays = payload.plays;
  if (typeof winnerId !== "string" || !Array.isArray(plays)) {
    return null;
  }

  const parsedPlays: TrickPlay[] = [];
  for (const play of plays) {
    const parsedPlay = asObject(play);
    if (!parsedPlay) {
      return null;
    }
    const playerId = parsedPlay.playerId;
    const cardId = parsedPlay.cardId;
    if (typeof playerId !== "string" || typeof cardId !== "string") {
      return null;
    }
    parsedPlays.push({ playerId, cardId });
  }

  return {
    winnerId,
    plays: parsedPlays,
  };
};

export function GameClient() {
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [roomState, setRoomState] = useState<RoomStatePayload | null>(null);
  const [gameState, setGameState] = useState<PublicGameView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedWinnerPlayerId, setSelectedWinnerPlayerId] = useState<
    string | null
  >(null);
  const [selectedSummaryPlayerId, setSelectedSummaryPlayerId] = useState<
    string | null
  >(null);
  const [selectedCompletedRoundIndex, setSelectedCompletedRoundIndex] =
    useState<number | null>(null);
  const [showHowToPlay, setShowHowToPlay] = useState(false);
  const [showAllHeroChips, setShowAllHeroChips] = useState(false);
  const [isHandOrdered, setIsHandOrdered] = useState(false);
  const [revealedCompletedTrick, setRevealedCompletedTrick] =
    useState<TrickRevealState | null>(null);
  const [copiedRoomCode, setCopiedRoomCode] = useState(false);

  const socketRef = useRef<GameSocket | null>(null);
  const trickRevealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const autoSummaryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const copiedRoomCodeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const previousGameStateRef = useRef<PublicGameView | null>(null);

  const clearTrickRevealTimeout = () => {
    if (!trickRevealTimeoutRef.current) {
      return;
    }
    clearTimeout(trickRevealTimeoutRef.current);
    trickRevealTimeoutRef.current = null;
  };

  const revealCompletedTrick = (trick: TrickRevealState) => {
    clearTrickRevealTimeout();
    setRevealedCompletedTrick(trick);
    trickRevealTimeoutRef.current = setTimeout(() => {
      setRevealedCompletedTrick(null);
      trickRevealTimeoutRef.current = null;
    }, TRICK_REVEAL_DURATION_MS);
  };

  const clearAutoSummaryTimeout = () => {
    if (!autoSummaryTimeoutRef.current) {
      return;
    }
    clearTimeout(autoSummaryTimeoutRef.current);
    autoSummaryTimeoutRef.current = null;
  };
  const clearCopiedRoomCodeTimeout = () => {
    if (!copiedRoomCodeTimeoutRef.current) {
      return;
    }
    clearTimeout(copiedRoomCodeTimeoutRef.current);
    copiedRoomCodeTimeoutRef.current = null;
  };

  const handleCopyRoomCode = async () => {
    if (!session?.roomCode) {
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(session.roomCode);
      } else {
        const fallbackInput = document.createElement("textarea");
        fallbackInput.value = session.roomCode;
        fallbackInput.setAttribute("readonly", "");
        fallbackInput.style.position = "absolute";
        fallbackInput.style.left = "-9999px";
        document.body.appendChild(fallbackInput);
        fallbackInput.select();
        document.execCommand("copy");
        document.body.removeChild(fallbackInput);
      }
      setCopiedRoomCode(true);
      clearCopiedRoomCodeTimeout();
      copiedRoomCodeTimeoutRef.current = setTimeout(() => {
        setCopiedRoomCode(false);
        copiedRoomCodeTimeoutRef.current = null;
      }, 1600);
    } catch {
      setError("Could not copy room code. Please copy it manually.");
    }
  };

  useEffect(() => {
    const existing = loadSession();
    if (existing) {
      setSession(existing);
      setName(existing.name);
      setJoinCode(existing.roomCode);
    }
  }, []);

  useEffect(() => {
    if (!session) {
      return;
    }

    const socket = createGameSocket();
    socketRef.current = socket;

    const joinCurrentRoom = () => {
      socket.emit("room:join", {
        roomCode: session.roomCode,
        playerId: session.playerId,
        sessionToken: session.sessionToken,
      });
      socket.emit("state:sync_request");
    };

    socket.on("connect", joinCurrentRoom);
    socket.on("room:state", (payload: RoomStatePayload) => {
      setRoomState(payload);
      setError(null);
    });
    socket.on("game:state", (payload: PublicGameView) => {
      const previousGameState = previousGameStateRef.current;
      const previousCompletedRoundCount =
        previousGameState?.completedRounds.length ?? payload.completedRounds.length;
      const roundCompleted =
        payload.completedRounds.length > previousCompletedRoundCount;
      if (payload.phase === "game_complete") {
        clearAutoSummaryTimeout();
      } else if (roundCompleted) {
        clearAutoSummaryTimeout();
        const completedRoundIndex = payload.completedRounds.length - 1;
        autoSummaryTimeoutRef.current = setTimeout(() => {
          setSelectedCompletedRoundIndex(completedRoundIndex);
          autoSummaryTimeoutRef.current = null;
        }, AUTO_SUMMARY_DELAY_MS);
      }
      setGameState(payload);
      previousGameStateRef.current = payload;
      setError(null);
    });
    socket.on("game:trick_reveal", (payload: unknown) => {
      const parsed = parseTrickRevealPayload(payload);
      if (!parsed) {
        return;
      }
      revealCompletedTrick(parsed);
    });
    socket.on("game:error", (payload: { code: string; message: string }) => {
      setError(payload.message);
    });
    socket.on("player:reconnected", (payload: { playerId: string }) => {
      if (payload.playerId === session.playerId) {
        setInfo("Reconnected to your seat.");
      }
    });

    return () => {
      clearTrickRevealTimeout();
      clearAutoSummaryTimeout();
      clearCopiedRoomCodeTimeout();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session]);

  useEffect(() => {
    if (!showHowToPlay) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowHowToPlay(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showHowToPlay]);

  const createRoomFlow = async () => {
    try {
      setError(null);
      setInfo(null);
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError("Name is required.");
        return;
      }
      const response = await createRoom(trimmedName);
      const nextSession: StoredSession = { ...response, name: trimmedName };
      saveSession(nextSession);
      setSession(nextSession);
      setJoinCode(response.roomCode);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const joinRoomFlow = async () => {
    try {
      setError(null);
      setInfo(null);
      const trimmedName = name.trim();
      const code = joinCode.trim().toUpperCase();
      if (!trimmedName) {
        setError("Name is required.");
        return;
      }
      if (!code) {
        setError("Room code is required.");
        return;
      }
      const response = await joinRoom(code, trimmedName);
      const nextSession: StoredSession = { ...response, name: trimmedName };
      saveSession(nextSession);
      setSession(nextSession);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const leaveSession = () => {
    clearSession();
    socketRef.current?.disconnect();
    socketRef.current = null;
    setSession(null);
    setRoomState(null);
    setGameState(null);
    setInfo(null);
    setShowHowToPlay(false);
    setShowAllHeroChips(false);
    setSelectedSummaryPlayerId(null);
    setSelectedCompletedRoundIndex(null);
    setRevealedCompletedTrick(null);
    setCopiedRoomCode(false);
    previousGameStateRef.current = null;
    clearTrickRevealTimeout();
    clearAutoSummaryTimeout();
    clearCopiedRoomCodeTimeout();
  };

  const isHost = roomState?.hostPlayerId === session?.playerId;
  const canStart =
    isHost &&
    roomState &&
    roomState.players.length >= 2 &&
    !gameState;
  const canEndGame =
    isHost && gameState !== null && gameState.phase !== "game_complete";
  const isMatchInProgress =
    gameState !== null && gameState.phase !== "game_complete";
  const gameStatusLabel = isMatchInProgress ? "Game in progress" : "Lobby open";
  const roomLockLabel = roomState?.locked ? "Room locked" : "Room open";
  const currentGamePlayerIds = useMemo(
    () => new Set((gameState?.players ?? []).map((player) => player.playerId)),
    [gameState?.players],
  );

  const bidding =
    gameState?.phase === "bidding" ? gameState.currentRound : null;
  const trickPlay =
    gameState?.phase === "trick_play" ? gameState.currentRound : null;
  const currentRound = gameState?.currentRound ?? null;
  const visibleRoundNumber = gameState ? gameState.roundNumber + 1 : 0;
  const isBidTurn = bidding?.bidTurnPlayerId === session?.playerId;
  const isPlayTurn = trickPlay?.turnPlayerId === session?.playerId;
  const displayTrickCards =
    revealedCompletedTrick?.plays ?? trickPlay?.currentTrick ?? [];
  const isTrickRevealActive = Boolean(revealedCompletedTrick);
  const isRoundTransitionRevealActive =
    isTrickRevealActive && gameState?.phase !== "trick_play";
  const activeTurnPlayerId = isRoundTransitionRevealActive
    ? null
    : trickPlay?.turnPlayerId ?? bidding?.bidTurnPlayerId ?? null;
  const isMyTurn = Boolean(
    session?.playerId && activeTurnPlayerId === session.playerId,
  );
  const handRound = isRoundTransitionRevealActive
    ? trickPlay
    : trickPlay ?? (bidding?.cardsDealt ? bidding : null);
  const winnerIdInDisplayedTrick = revealedCompletedTrick?.winnerId ?? null;
  const playerNameById = useMemo(
    () =>
      Object.fromEntries(
        (gameState?.players ?? []).map((player) => [
          player.playerId,
          player.name,
        ]),
      ),
    [gameState?.players],
  );
  const getPlayerName = (playerId: string): string =>
    playerNameById[playerId] ?? playerId;
  const turnPlayerName = activeTurnPlayerId
    ? getPlayerName(activeTurnPlayerId)
    : null;
  const turnPromptText =
    isMyTurn && trickPlay
      ? "Play a legal card."
      : isMyTurn && bidding
        ? "Place your bid."
        : turnPlayerName
          ? `${turnPlayerName} is up.`
          : null;

  const submitBid = (bid: number) => {
    socketRef.current?.emit("bid:submit", { bid });
  };

  const playCard = (cardId: string) => {
    socketRef.current?.emit("card:play", { cardId });
  };

  const scoreboard = useMemo(() => {
    if (!gameState) {
      return [];
    }
    return gameState.players.map((player) => ({
      playerId: player.playerId,
      name: player.name,
      score: gameState.scores[player.playerId] ?? 0,
    }));
  }, [gameState]);
  const sortedFinalScores = useMemo(() => {
    if (!gameState) {
      return [];
    }
    return [...gameState.players]
      .map((player) => ({
        playerId: player.playerId,
        name: player.name,
        score: gameState.scores[player.playerId] ?? 0,
      }))
      .sort((a, b) => b.score - a.score);
  }, [gameState]);
  const winningScore = sortedFinalScores[0]?.score ?? 0;
  const winners = sortedFinalScores.filter(
    (entry) => entry.score === winningScore,
  );

  const selectedPlayerWonTricks = useMemo(() => {
    if (!currentRound || !selectedWinnerPlayerId) {
      return [];
    }
    return currentRound.trickHistory
      .map((trick, index) => ({ ...trick, trickNumber: index + 1 }))
      .filter((trick) => trick.winnerId === selectedWinnerPlayerId);
  }, [currentRound, selectedWinnerPlayerId]);
  const selectedCompletedRound: RoundSummary | null = useMemo(() => {
    if (selectedCompletedRoundIndex === null || !gameState) {
      return null;
    }
    return gameState.completedRounds[selectedCompletedRoundIndex] ?? null;
  }, [gameState, selectedCompletedRoundIndex]);
  const trumpSuit = currentRound?.trumpSuit ?? null;
  const trumpPreviewCardId = trumpSuit ? `A${trumpSuit}` : null;
  const getTrumpSuitLabel = (suit: Suit): string => TRUMP_SUIT_LABEL[suit];
  const getTrumpSuitDisplay = (suit: Suit): React.ReactNode => (
    <>
      {TRUMP_SUIT_LABEL[suit]}{" "}
      <span
        className={`suit-symbol ${
          suit === "H" || suit === "D" ? "suit-symbol--red" : "suit-symbol--dark"
        }`}
      >
        ({SUIT_SYMBOL[suit]})
      </span>
    </>
  );
  const visibleHandCards = useMemo(() => {
    if (!handRound) {
      return [];
    }
    if (!isHandOrdered) {
      return handRound.viewerHand;
    }
    return sortHandCards(handRound.viewerHand, handRound.trumpSuit);
  }, [handRound, isHandOrdered]);
  const visibleHeroChips = showAllHeroChips
    ? [...HERO_PRIMARY_CHIPS, ...HERO_EXTRA_CHIPS]
    : HERO_PRIMARY_CHIPS;
  const hiddenHeroChipCount = HERO_EXTRA_CHIPS.length;

  useEffect(() => {
    setIsHandOrdered(false);
  }, [currentRound?.roundIndex]);

  useEffect(() => {
    document.title = isMyTurn
      ? "Your turn • Kachuful"
      : "Kachuful Multiplayer";
    return () => {
      document.title = "Kachuful Multiplayer";
    };
  }, [isMyTurn]);

  if (!session) {
    return (
      <>
        <section className="app-hero">
          <p className="app-hero__subtitle">
            Create a room, share the code, and start playing with friends in
            seconds.
          </p>
          <div className="app-hero__chips">
            {visibleHeroChips.map((chip) => (
              <span
                className={`pill app-hero__chip ${
                  chip.tone === "accent" ? "app-hero__chip--accent" : ""
                }`}
                key={chip.id}
              >
                {chip.label}
              </span>
            ))}
            {hiddenHeroChipCount > 0 ? (
              <button
                aria-expanded={showAllHeroChips}
                className="pill app-hero__chip app-hero__chip-toggle"
                onClick={() => setShowAllHeroChips((current) => !current)}
                type="button"
              >
                {showAllHeroChips ? "Show less" : `+${hiddenHeroChipCount} more`}
              </button>
            ) : null}
          </div>
        </section>
        <section className="lobby-shell">
          <h2>Join or Create Room</h2>
          <p className="lobby-shell__subtitle">
            Enter your name once, then create a room or join with a shared code.
          </p>
          <div className="lobby-steps">
            <span className="lobby-step">1. Enter your name</span>
            <span className="lobby-step">2. Create or join room</span>
            <span className="lobby-step">3. Share room code</span>
          </div>
          <div className="lobby-name">
            <label className="lobby-label" htmlFor="player-name-input">
              Player name
            </label>
            <input
              id="player-name-input"
              aria-label="name"
              placeholder="Your name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="lobby-grid">
            <form
              className="lobby-card"
              onSubmit={(event) => {
                event.preventDefault();
                void createRoomFlow();
              }}
            >
              <h3>Create Room</h3>
              <p>Start a private table and invite players with a room code.</p>
              <button className="btn-success" type="submit">
                Create room
              </button>
            </form>
            <form
              className="lobby-card lobby-card--join"
              onSubmit={(event) => {
                event.preventDefault();
                void joinRoomFlow();
              }}
            >
              <h3>Join Room</h3>
              <p>Paste the room code shared by the host.</p>
              <label className="lobby-label" htmlFor="room-code-input">
                Room code
              </label>
              <input
                id="room-code-input"
                aria-label="room-code"
                placeholder="Room code"
                value={joinCode}
                onChange={(event) =>
                  setJoinCode(event.target.value.toUpperCase())
                }
              />
              <button className="btn-info" type="submit">
                Join room
              </button>
            </form>
          </div>
          {error ? <p className="error">{error}</p> : null}
        </section>
      </>
    );
  }

  return (
    <>
      <section className="room-shell">
        <div className="room-header">
          <h2>Room {session.roomCode}</h2>
          <button
            aria-label="Copy room code"
            className="secondary btn-info-soft room-copy-button"
            onClick={() => {
              void handleCopyRoomCode();
            }}
            type="button"
          >
            {copiedRoomCode ? "Copied" : "Copy code"}
          </button>
        </div>
        <div className="row room-actions">
          <button
            className="secondary btn-info-soft"
            onClick={() => setShowHowToPlay(true)}
            type="button"
          >
            How to Play
          </button>
          <button
            className="secondary btn-info"
            onClick={() => {
              socketRef.current?.emit("state:sync_request");
            }}
            type="button"
          >
            Sync state
          </button>
          <button className="secondary btn-danger-soft" onClick={leaveSession} type="button">
            Leave
          </button>
          {isHost && roomState ? (
            <button
              className={`secondary ${
                roomState.locked ? "btn-success-soft" : "btn-warning-soft"
              }`}
              onClick={() => {
                socketRef.current?.emit("room:lock_toggle", {
                  locked: !roomState.locked,
                });
              }}
              type="button"
            >
              {roomState.locked ? "Unlock room" : "Lock room"}
            </button>
          ) : null}
          {canEndGame ? (
            <button
              className="btn-danger room-actions__primary"
              onClick={() => {
                socketRef.current?.emit("game:end");
              }}
              type="button"
            >
              End game
            </button>
          ) : null}
          {canStart ? (
            <button
              className="btn-success room-actions__primary"
              onClick={() => {
                socketRef.current?.emit("game:start");
              }}
              type="button"
            >
              Start game
            </button>
          ) : null}
        </div>
        <p className="room-status-line">
          {gameStatusLabel}
          {roomState ? ` • ${roomLockLabel}` : ""}
        </p>
        {roomState ? (
          <div className="room-player-list">
            {roomState.players.map((player) => {
              const isSpectator =
                isMatchInProgress && !currentGamePlayerIds.has(player.playerId);
              return (
                <p className="room-player" key={player.playerId}>
                  <span
                    aria-label={`${player.name} ${player.connected ? "online" : "offline"}`}
                    className={`status-dot ${player.connected ? "status-dot--online" : "status-dot--offline"}`}
                    role="img"
                  />
                  <span>{player.name}</span>
                  {player.playerId === roomState.hostPlayerId ? (
                    <span className="pill">host</span>
                  ) : null}
                  {isSpectator ? <span className="pill">spectator</span> : null}
                </p>
              );
            })}
          </div>
        ) : null}
        {info ? <p>{info}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      {gameState ? (
        <>
          <section className="game-shell">
            <div className="game-main">
              <h2>Game</h2>
              <p>Round: {visibleRoundNumber}</p>
              {activeTurnPlayerId && turnPromptText ? (
                <div
                  aria-live="polite"
                  className={`turn-banner ${
                    isMyTurn ? "turn-banner--self" : "turn-banner--waiting"
                  }`}
                  role="status"
                >
                  <span className="turn-banner__label">
                    {isMyTurn ? "Your turn" : "Current turn"}
                  </span>
                  <span className="turn-banner__text">{turnPromptText}</span>
                </div>
              ) : null}

              {bidding && !isRoundTransitionRevealActive ? (
                <div>
                  {isBidTurn ? (
                    <div className="row turn-actions turn-actions--active">
                      {bidValues(bidding.cardsPerPlayer).map((bid) => (
                        <button
                          className="turn-actions__button btn-success"
                          key={bid}
                          onClick={() => submitBid(bid)}
                          type="button"
                          disabled={bidding.forbiddenDealerBid === bid}
                        >
                          Bid {bid}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p>Waiting for another player to bid.</p>
                  )}
                  {bidding.blind && !bidding.cardsDealt ? (
                    <p>
                      Cards will be revealed after all blind bids are locked.
                    </p>
                  ) : null}
                </div>
              ) : null}

              {trickPlay || isTrickRevealActive ? (
                <div>
                  <div>
                    <p>Cards on table</p>
                    <div className="cards">
                      {displayTrickCards.map((play) => (
                        <span
                          className={`trick-card${
                            winnerIdInDisplayedTrick === play.playerId
                              ? " trick-card--winner"
                              : ""
                          }`}
                          key={`${play.playerId}-${play.cardId}`}
                        >
                          <span className="trick-card__player">
                            {getPlayerName(play.playerId)}
                          </span>
                          <PlayingCard cardId={play.cardId} />
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {handRound ? (
                <div className="hand-section">
                  <div className="hand-section__header">
                    <p>Your hand</p>
                    <button
                      className="secondary btn-warning-soft"
                      onClick={() => setIsHandOrdered(true)}
                      type="button"
                    >
                      Order hand
                    </button>
                  </div>
                  <div className="cards">
                    {visibleHandCards.map((cardId) => {
                      const isLegalPlay = Boolean(
                        trickPlay &&
                        isPlayTurn &&
                        !isTrickRevealActive &&
                        trickPlay.legalCardIds.includes(cardId),
                      );
                      const shouldDimCard = Boolean(
                        trickPlay && !isPlayTurn && !isTrickRevealActive,
                      );
                      return (
                        <button
                          aria-label={cardId}
                          className={`card-button${
                            isLegalPlay ? " card-button--turn-legal" : ""
                          }${shouldDimCard ? " card-button--waiting" : ""}`}
                          disabled={!isLegalPlay}
                          key={cardId}
                          onClick={() => playCard(cardId)}
                          title={cardId}
                          type="button"
                        >
                          <PlayingCard cardId={cardId} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className="game-details-shell">
            <div className="game-details-layout">
              <div className="game-score-panel">
                <h3>Scoreboard</h3>
                <div className="table-scroll table-scroll--wide">
                  <table className="score-table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scoreboard.map((row) => (
                        <tr key={row.playerId}>
                          <td>{row.name}</td>
                          <td>{row.score}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {gameState.phase === "game_complete" ? (
                  <div className="final-results">
                    <h3>Game Complete</h3>
                    <p className="final-results__winner">
                      Winner{winners.length > 1 ? "s" : ""}:{" "}
                      {winners.map((winner) => winner.name).join(", ")} (
                      {winningScore} points)
                    </p>
                    {isHost ? (
                      <button
                        className="btn-success"
                        onClick={() => {
                          socketRef.current?.emit("game:restart");
                        }}
                        type="button"
                      >
                        Start New Game
                      </button>
                    ) : null}

                    <h4>Final Standings</h4>
                    <div className="table-scroll table-scroll--wide">
                      <table className="final-results__table">
                        <thead>
                          <tr>
                            <th>Rank</th>
                            <th>Player</th>
                            <th>Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedFinalScores.map((entry, index) => (
                            <tr key={`final-standings-${entry.playerId}`}>
                              <td>{index + 1}</td>
                              <td>{entry.name}</td>
                              <td>{entry.score}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <h4>Round-by-Round Breakdown</h4>
                    <div className="table-scroll table-scroll--breakdown">
                      <table className="final-results__table">
                        <thead>
                          <tr>
                            <th>Round</th>
                            <th>Cards</th>
                            <th>Trump</th>
                            {gameState.players.map((player) => (
                              <th key={`final-breakdown-header-${player.playerId}`}>
                                {player.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {gameState.completedRounds.map((round) => (
                            <tr key={`final-breakdown-row-${round.roundIndex}`}>
                              <td>{round.roundIndex + 1}</td>
                              <td>{round.cardsPerPlayer}</td>
                              <td>{getTrumpSuitLabel(round.trumpSuit)}</td>
                              {gameState.players.map((player) => {
                                const playerId = player.playerId;
                                const bid = round.bids[playerId] ?? 0;
                                const won = round.tricksWon[playerId] ?? 0;
                                const points = round.scoreDelta[playerId] ?? 0;
                                return (
                                  <td
                                    key={`final-breakdown-cell-${round.roundIndex}-${playerId}`}
                                  >
                                    {bid}/{won} (
                                    {points > 0 ? `+${points}` : points})
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>

              <aside className="round-stats">
                <div className="round-info">
                  <h3>Round Info</h3>
                  <p className="round-stats__meta">
                    No. of cards:{" "}
                    <strong>{currentRound?.cardsPerPlayer ?? "-"}</strong>
                  </p>
                  <p className="round-stats__meta">
                    Trump:{" "}
                    <strong>
                      {trumpSuit ? getTrumpSuitLabel(trumpSuit) : "-"}
                    </strong>
                  </p>
                  <div className="round-info__trump">
                    {trumpPreviewCardId ? (
                      <div
                        aria-label={`Trump preview ${trumpPreviewCardId}`}
                        className="round-info__trump-card"
                      >
                        <PlayingCard cardId={trumpPreviewCardId} />
                      </div>
                    ) : (
                      <p>No active round.</p>
                    )}
                  </div>
                </div>

                <h3>Round Tracker</h3>
                <p className="round-stats__hint">
                  Current round bids and tricks won.
                </p>
                {currentRound ? (
                  <div className="round-stats__list">
                    {gameState.players.map((player) => {
                      const bidRaw = currentRound.bids[player.playerId];
                      const bid = typeof bidRaw === "number" ? bidRaw : null;
                      const won = currentRound.tricksWon[player.playerId] ?? 0;
                      const isSelf = session?.playerId === player.playerId;
                      const isActiveTurn = activeTurnPlayerId === player.playerId;
                      const handsNeeded = bid === null ? 0 : bid - won;
                      const handsNeededText =
                        bid === null
                          ? "-"
                          : handsNeeded > 0
                            ? `Need ${handsNeeded}`
                            : handsNeeded < 0
                              ? `Over by ${Math.abs(handsNeeded)}`
                              : "On target";
                      const handsNeededClass =
                        bid === null
                          ? "round-stats__needed--unknown"
                          : handsNeeded > 0
                            ? "round-stats__needed--need"
                            : handsNeeded < 0
                              ? "round-stats__needed--over"
                              : "round-stats__needed--on-target";
                      const wonCount = currentRound.trickHistory.filter(
                        (trick) => trick.winnerId === player.playerId,
                      ).length;
                      return (
                        <div
                          className={`round-stats__row${isSelf ? " round-stats__row--self" : ""}${
                            isActiveTurn ? " round-stats__row--active-turn" : ""
                          }`}
                          key={player.playerId}
                        >
                          <div className="round-stats__name-row">
                            <p className="round-stats__name">{player.name}</p>
                            {isActiveTurn ? (
                              <span className="pill round-stats__turn-pill">
                                Playing now
                              </span>
                            ) : null}
                          </div>
                          <p className="round-stats__meta">Bid: {bid ?? "-"}</p>
                          <p className="round-stats__meta">Won: {won}</p>
                          <p className={`round-stats__needed ${handsNeededClass}`}>
                            Hands needed: {handsNeededText}
                          </p>
                          <button
                            aria-label={`View winning tricks for ${player.name}`}
                            className="secondary btn-info-soft round-stats__button"
                            disabled={wonCount === 0}
                            onClick={() =>
                              setSelectedWinnerPlayerId(player.playerId)
                            }
                            type="button"
                          >
                            Winning tricks ({wonCount})
                          </button>
                          <button
                            aria-label={`View round summary for ${player.name}`}
                            className="secondary btn-info-soft round-stats__button"
                            disabled={gameState.completedRounds.length === 0}
                            onClick={() =>
                              setSelectedSummaryPlayerId(player.playerId)
                            }
                            type="button"
                          >
                            Round summary
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p>No active round.</p>
                )}
              </aside>
            </div>
          </section>
        </>
      ) : null}

      {selectedWinnerPlayerId && currentRound ? (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedWinnerPlayerId(null)}
          role="presentation"
        >
          <div
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-card__header">
              <h3>{getPlayerName(selectedWinnerPlayerId)} winning tricks</h3>
              <button
                className="secondary"
                onClick={() => setSelectedWinnerPlayerId(null)}
                type="button"
              >
                Close
              </button>
            </div>
            {selectedPlayerWonTricks.length === 0 ? (
              <p>No tricks won in this round yet.</p>
            ) : (
              <div className="won-tricks">
                {selectedPlayerWonTricks.map((trick) => (
                  <div
                    className="won-tricks__item"
                    key={`won-${trick.trickNumber}`}
                  >
                    <p className="won-tricks__title">
                      Trick {trick.trickNumber}
                    </p>
                    <div className="cards">
                      {trick.plays.map((play) => (
                        <span
                          className="trick-card"
                          key={`won-${trick.trickNumber}-${play.playerId}`}
                        >
                          <span className="trick-card__player">
                            {getPlayerName(play.playerId)}
                          </span>
                          <PlayingCard cardId={play.cardId} />
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {selectedCompletedRound && gameState ? (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedCompletedRoundIndex(null)}
          role="presentation"
        >
          <div
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-card__header">
              <h3>Round {selectedCompletedRound.roundIndex + 1} Summary</h3>
              <button
                className="secondary"
                onClick={() => setSelectedCompletedRoundIndex(null)}
                type="button"
              >
                Close
              </button>
            </div>
            <p>
              Cards: {selectedCompletedRound.cardsPerPlayer} | Trump:{" "}
              {getTrumpSuitDisplay(selectedCompletedRound.trumpSuit)}
            </p>
            <div className="table-scroll table-scroll--breakdown">
              <table className="summary-table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>Bid</th>
                    <th>Won</th>
                    <th>Result</th>
                    <th>Round Points</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {gameState.players.map((player) => {
                    const playerId = player.playerId;
                    const bid = selectedCompletedRound.bids[playerId] ?? 0;
                    const won = selectedCompletedRound.tricksWon[playerId] ?? 0;
                    const points =
                      selectedCompletedRound.scoreDelta[playerId] ?? 0;
                    const total = gameState.scores[playerId] ?? 0;
                    const hit = bid === won;
                    return (
                      <tr key={`round-summary-${selectedCompletedRound.roundIndex}-${playerId}`}>
                        <td>{player.name}</td>
                        <td>{bid}</td>
                        <td>{won}</td>
                        <td>
                          <span
                            aria-label={hit ? "Hit" : "Miss"}
                            className={`summary-result ${
                              hit ? "summary-result--hit" : "summary-result--miss"
                            }`}
                            title={hit ? "Hit" : "Miss"}
                          >
                            {hit ? "✓" : "✗"}
                          </span>
                        </td>
                        <td>{points > 0 ? `+${points}` : `${points}`}</td>
                        <td>{total}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {selectedSummaryPlayerId && gameState ? (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedSummaryPlayerId(null)}
          role="presentation"
        >
          <div
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-card__header">
              <h3>
                {getPlayerName(selectedSummaryPlayerId)} Round-by-Round Summary
              </h3>
              <button
                className="secondary"
                onClick={() => setSelectedSummaryPlayerId(null)}
                type="button"
              >
                Close
              </button>
            </div>
            <div className="table-scroll table-scroll--breakdown">
              <table className="summary-table">
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Trump Suit</th>
                    <th>Bid</th>
                    <th>Won</th>
                    <th>Result</th>
                    <th>Round Points</th>
                  </tr>
                </thead>
                <tbody>
                  {gameState.completedRounds.map((round) => {
                    const bid = round.bids[selectedSummaryPlayerId] ?? 0;
                    const won = round.tricksWon[selectedSummaryPlayerId] ?? 0;
                    const points = round.scoreDelta[selectedSummaryPlayerId] ?? 0;
                    const hit = bid === won;
                    return (
                      <tr
                        key={`summary-${selectedSummaryPlayerId}-${round.roundIndex}`}
                      >
                        <td>{round.roundIndex + 1}</td>
                        <td>{getTrumpSuitDisplay(round.trumpSuit)}</td>
                        <td>{bid}</td>
                        <td>{won}</td>
                        <td>
                          <span
                            aria-label={hit ? "Hit" : "Miss"}
                            className={`summary-result ${
                              hit ? "summary-result--hit" : "summary-result--miss"
                            }`}
                            title={hit ? "Hit" : "Miss"}
                          >
                            {hit ? "✓" : "✗"}
                          </span>
                        </td>
                        <td>{points > 0 ? `+${points}` : `${points}`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {showHowToPlay ? (
        <div
          className="modal-backdrop"
          onClick={() => setShowHowToPlay(false)}
          role="presentation"
        >
          <div
            aria-modal="true"
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-card__header">
              <h3>How to Play Kachuful</h3>
              <button
                className="secondary"
                onClick={() => setShowHowToPlay(false)}
                type="button"
              >
                Close
              </button>
            </div>
            <p className="howto-intro">
              Learn the flow quickly, then use the controls confidently during live rounds.
            </p>

            <div className="howto-quickstart">
              <div className="howto-step">
                <span className="howto-step__index">1</span>
                <p>Create or join a private room with a code.</p>
              </div>
              <div className="howto-step">
                <span className="howto-step__index">2</span>
                <p>Bid exactly what you expect to win.</p>
              </div>
              <div className="howto-step">
                <span className="howto-step__index">3</span>
                <p>Follow suit, win tricks, and hit your bid for points.</p>
              </div>
            </div>

            <div className="howto-accordions">
              <details className="howto-accordion" open>
                <summary>Round Flow</summary>
                <ul className="howto-list">
                  <li>2 to 6 players can join a room.</li>
                  <li>Round pattern is 1,2,3,4,5,6,7,8,7,6,5,4,3,2,1 cards.</li>
                  <li>Trump rotates every round: Spades, Diamonds, Clubs, Hearts.</li>
                  <li>Round 1 is blind: bids lock first, then cards are revealed.</li>
                  <li>Dealer cannot make the final bid that makes total bids equal total tricks.</li>
                  <li>You must follow lead suit whenever possible.</li>
                  <li>Completed tricks stay visible for 2 seconds with winner highlight.</li>
                </ul>
              </details>

              <details className="howto-accordion" open>
                <summary>Winning & Scoring</summary>
                <ul className="howto-list">
                  <li>Highest trump wins the trick; if no trump is played, highest lead suit wins.</li>
                  <li>Exact bid scores 10 + tricks won; miss scores 0 for that round.</li>
                </ul>

                <div className="table-scroll table-scroll--wide">
                  <table className="howto-score-table">
                    <thead>
                      <tr>
                        <th>Bid</th>
                        <th>Won</th>
                        <th>Result</th>
                        <th>Round Points</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>2</td>
                        <td>2</td>
                        <td>✓ Hit</td>
                        <td>+12</td>
                      </tr>
                      <tr>
                        <td>2</td>
                        <td>1</td>
                        <td>✗ Miss</td>
                        <td>0</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="howto-trick">
                  <p className="howto-trick__title">Trick example (Trump: Spades)</p>
                  <div className="cards">
                    <span className="trick-card">
                      <span className="trick-card__player">Lead</span>
                      <PlayingCard cardId="9H" />
                    </span>
                    <span className="trick-card">
                      <span className="trick-card__player">Follow</span>
                      <PlayingCard cardId="QH" />
                    </span>
                    <span className="trick-card trick-card--winner">
                      <span className="trick-card__player">Trump wins</span>
                      <PlayingCard cardId="2S" />
                    </span>
                  </div>
                </div>
              </details>

              <details className="howto-accordion" open>
                <summary>Buttons & Controls</summary>
                <ul className="howto-list">
                  <li>
                    <span className="howto-control-tag">Create room</span>
                    Start a new private room code.
                  </li>
                  <li>
                    <span className="howto-control-tag">Join room</span>
                    Join an existing room by code.
                  </li>
                  <li>
                    <span className="howto-control-tag">Copy code</span>
                    Copy room code to clipboard.
                  </li>
                  <li>
                    <span className="howto-control-tag">Lock / Unlock room</span>
                    Host controls whether new names can join.
                  </li>
                  <li>
                    <span className="howto-control-tag howto-control-tag--success">Start game</span>
                    Host only; requires at least 2 online players.
                  </li>
                  <li>
                    <span className="howto-control-tag howto-control-tag--danger">End game</span>
                    Host can finish the active match early.
                  </li>
                  <li>
                    <span className="howto-control-tag">Bid X</span>
                    Submit your bid for the round.
                  </li>
                  <li>
                    <span className="howto-control-tag">Order hand</span>
                    Sort cards with trump suit first.
                  </li>
                  <li>
                    <span className="howto-control-tag">Winning tricks</span>
                    View tricks won by a player this round.
                  </li>
                  <li>
                    <span className="howto-control-tag">Round summary</span>
                    View that player’s round-by-round results.
                  </li>
                  <li>
                    <span className="howto-control-tag">Sync state</span>
                    Re-fetch latest room and game state.
                  </li>
                  <li>
                    <span className="howto-control-tag">Leave</span>
                    Exit room on this device.
                  </li>
                  <li>
                    <span className="howto-control-tag">Spectator</span>
                    Mid-match joiners can watch; only online players are included on restart.
                  </li>
                </ul>
              </details>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
