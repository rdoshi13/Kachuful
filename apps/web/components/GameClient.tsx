"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  PublicGameView,
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
const TRUMP_SUIT_LABEL: Record<Suit, string> = {
  S: "Spades",
  D: "Diamonds",
  C: "Clubs",
  H: "Hearts",
};
const PHASE_LABEL_OVERRIDES: Partial<Record<PublicGameView["phase"], string>> =
  {
    bidding: "Bidding",
    trick_play: "Play",
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

const toTitleCase = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

const getPhaseLabel = (phase: PublicGameView["phase"]): string =>
  PHASE_LABEL_OVERRIDES[phase] ??
  phase
    .split("_")
    .map((segment) => toTitleCase(segment))
    .join(" ");

interface TrickRevealState {
  plays: TrickPlay[];
  winnerId: string;
}

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
  const [isHandOrdered, setIsHandOrdered] = useState(false);
  const [revealedCompletedTrick, setRevealedCompletedTrick] =
    useState<TrickRevealState | null>(null);

  const socketRef = useRef<GameSocket | null>(null);
  const trickRevealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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
      setGameState(payload);
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
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session]);

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
    setSelectedSummaryPlayerId(null);
    setRevealedCompletedTrick(null);
    clearTrickRevealTimeout();
  };

  const isHost = roomState?.hostPlayerId === session?.playerId;
  const canStart =
    isHost &&
    roomState &&
    roomState.players.length >= 2 &&
    !roomState.locked &&
    !gameState;

  const bidding =
    gameState?.phase === "bidding" ? gameState.currentRound : null;
  const trickPlay =
    gameState?.phase === "trick_play" ? gameState.currentRound : null;
  const currentRound = gameState?.currentRound ?? null;
  const visibleRoundNumber = gameState ? gameState.roundNumber + 1 : 0;
  const handRound = trickPlay ?? (bidding?.cardsDealt ? bidding : null);
  const isBidTurn = bidding?.bidTurnPlayerId === session?.playerId;
  const isPlayTurn = trickPlay?.turnPlayerId === session?.playerId;
  const displayTrickCards =
    revealedCompletedTrick?.plays ?? trickPlay?.currentTrick ?? [];
  const isTrickRevealActive = Boolean(revealedCompletedTrick);
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
  const trumpSuit = currentRound?.trumpSuit ?? null;
  const trumpPreviewCardId = trumpSuit ? `A${trumpSuit}` : null;
  const getTrumpSuitLabel = (suit: Suit): string => TRUMP_SUIT_LABEL[suit];
  const visibleHandCards = useMemo(() => {
    if (!handRound) {
      return [];
    }
    if (!isHandOrdered) {
      return handRound.viewerHand;
    }
    return sortHandCards(handRound.viewerHand, handRound.trumpSuit);
  }, [handRound, isHandOrdered]);

  if (!session) {
    return (
      <section>
        <h2>Join or Create Room</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createRoomFlow();
          }}
        >
          <input
            aria-label="name"
            placeholder="Your name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit">Create room</button>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void joinRoomFlow();
          }}
        >
          <input
            aria-label="room-code"
            placeholder="Room code"
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
          />
          <button type="submit">Join room</button>
        </form>
        {error ? <p className="error">{error}</p> : null}
      </section>
    );
  }

  return (
    <>
      <section>
        <h2>
          Room {session.roomCode}
          <span className="pill">{session.name}</span>
        </h2>
        <div className="row">
          <button
            className="secondary"
            onClick={() => {
              socketRef.current?.emit("state:sync_request");
            }}
            type="button"
          >
            Sync state
          </button>
          <button className="secondary" onClick={leaveSession} type="button">
            Leave
          </button>
          {canStart ? (
            <button
              onClick={() => {
                socketRef.current?.emit("game:start");
              }}
              type="button"
            >
              Start game
            </button>
          ) : null}
        </div>
        <p>{roomState?.locked ? "Game in progress" : "Lobby open"}</p>
        {roomState ? (
          <div>
            {roomState.players.map((player) => (
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
              </p>
            ))}
          </div>
        ) : null}
        {info ? <p>{info}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      {gameState ? (
        <section>
          <div className="game-layout">
            <div className="game-main">
              <h2>Game</h2>
              <p>Phase: {getPhaseLabel(gameState.phase)}</p>
              <p>Round: {visibleRoundNumber}</p>

              {bidding ? (
                <div>
                  <p>
                    Turn:{" "}
                    {bidding.bidTurnPlayerId
                      ? getPlayerName(bidding.bidTurnPlayerId)
                      : "-"}
                  </p>
                  {isBidTurn ? (
                    <div className="row">
                      {bidValues(bidding.cardsPerPlayer).map((bid) => (
                        <button
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
                  {trickPlay ? (
                    <p>
                      Turn:{" "}
                      {trickPlay.turnPlayerId
                        ? getPlayerName(trickPlay.turnPlayerId)
                        : "-"}
                    </p>
                  ) : null}
                  <div>
                    <p>
                      {isTrickRevealActive ? "Last trick" : "Current trick"}
                    </p>
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
                      className="secondary"
                      onClick={() => setIsHandOrdered(true)}
                      type="button"
                    >
                      Order hand
                    </button>
                  </div>
                  <div className="cards">
                    {visibleHandCards.map((cardId) => {
                      const canPlay = Boolean(
                        trickPlay &&
                        isPlayTurn &&
                        !isTrickRevealActive &&
                        trickPlay.legalCardIds.includes(cardId),
                      );
                      return (
                        <button
                          aria-label={cardId}
                          className="card-button"
                          disabled={!canPlay}
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

              <h3>Scoreboard</h3>
              <table>
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
                      onClick={() => {
                        socketRef.current?.emit("game:restart");
                      }}
                      type="button"
                    >
                      Start New Game
                    </button>
                  ) : null}

                  <h4>Final Standings</h4>
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

                  <h4>Round-by-Round Breakdown</h4>
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
                    const bid = currentRound.bids[player.playerId];
                    const won = currentRound.tricksWon[player.playerId] ?? 0;
                    const isSelf = session?.playerId === player.playerId;
                    const wonCount = currentRound.trickHistory.filter(
                      (trick) => trick.winnerId === player.playerId,
                    ).length;
                    return (
                      <div
                        className={`round-stats__row${isSelf ? " round-stats__row--self" : ""}`}
                        key={player.playerId}
                      >
                        <p className="round-stats__name">{player.name}</p>
                        <p className="round-stats__meta">Bid: {bid ?? "-"}</p>
                        <p className="round-stats__meta">Won: {won}</p>
                        <button
                          aria-label={`View winning tricks for ${player.name}`}
                          className="secondary round-stats__button"
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
                          className="secondary round-stats__button"
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
                      <td>{getTrumpSuitLabel(round.trumpSuit)}</td>
                      <td>{bid}</td>
                      <td>{won}</td>
                      <td>{hit ? "Hit" : "Miss"}</td>
                      <td>{points > 0 ? `+${points}` : `${points}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
