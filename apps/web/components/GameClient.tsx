"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PublicGameView, RoomStatePayload } from "@kachuful/shared-types";
import type { Socket } from "socket.io-client";
import { createRoom, joinRoom } from "../lib/api";
import {
  clearSession,
  loadSession,
  saveSession,
  type StoredSession,
} from "../lib/session";
import { createGameSocket } from "../lib/socket";
import { PlayingCard } from "./PlayingCard";

const bidValues = (max: number): number[] =>
  Array.from({ length: max + 1 }, (_, index) => index);
const TRUMP_SUIT_ORDER = ["S", "D", "C", "H"] as const;

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

  const socketRef = useRef<Socket | null>(null);

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
    socket.on("game:error", (payload: { code: string; message: string }) => {
      setError(payload.message);
    });
    socket.on("player:reconnected", (payload: { playerId: string }) => {
      if (payload.playerId === session.playerId) {
        setInfo("Reconnected to your seat.");
      }
    });

    return () => {
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
  };

  const isHost = roomState?.hostPlayerId === session?.playerId;
  const canStart = isHost && roomState && !roomState.locked && !gameState;

  const bidding =
    gameState?.phase === "bidding" ? gameState.currentRound : null;
  const trickPlay =
    gameState?.phase === "trick_play" ? gameState.currentRound : null;
  const currentRound = gameState?.currentRound ?? null;
  const visibleRoundNumber = gameState ? gameState.roundNumber + 1 : 0;
  const handRound = trickPlay ?? (bidding?.cardsDealt ? bidding : null);
  const isBidTurn = bidding?.bidTurnPlayerId === session?.playerId;
  const isPlayTurn = trickPlay?.turnPlayerId === session?.playerId;
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

  const selectedPlayerWonTricks = useMemo(() => {
    if (!currentRound || !selectedWinnerPlayerId) {
      return [];
    }
    return currentRound.trickHistory
      .map((trick, index) => ({ ...trick, trickNumber: index + 1 }))
      .filter((trick) => trick.winnerId === selectedWinnerPlayerId);
  }, [currentRound, selectedWinnerPlayerId]);
  const trumpSuit = useMemo(() => {
    if (!gameState || visibleRoundNumber <= 0) {
      return null;
    }
    const index = (visibleRoundNumber - 1) % TRUMP_SUIT_ORDER.length;
    return TRUMP_SUIT_ORDER[index];
  }, [gameState, visibleRoundNumber]);
  const trumpPreviewCardId = trumpSuit ? `A${trumpSuit}` : null;

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
              <p key={player.playerId}>
                {player.name}
                {player.playerId === roomState.hostPlayerId ? (
                  <span className="pill">host</span>
                ) : null}
                <span className="pill">
                  {player.connected ? "online" : "offline"}
                </span>
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
            <div>
              <h2>Game</h2>
              <p>Phase: {gameState.phase}</p>
              <p>Round: {visibleRoundNumber}</p>

              {bidding ? (
                <div>
                  <h3>Bidding</h3>
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

              {trickPlay ? (
                <div>
                  <h3>Trick Play</h3>
                  <p>
                    Turn:{" "}
                    {trickPlay.turnPlayerId
                      ? getPlayerName(trickPlay.turnPlayerId)
                      : "-"}
                  </p>
                  <div>
                    <p>Current trick</p>
                    <div className="cards">
                      {trickPlay.currentTrick.map((play) => (
                        <span
                          className="trick-card"
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
                <div>
                  <p>Your hand</p>
                  <div className="cards">
                    {handRound.viewerHand.map((cardId) => {
                      const canPlay = Boolean(
                        trickPlay &&
                        isPlayTurn &&
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
            </div>

            <aside className="round-stats">
              <div className="round-info">
                <h3>Round Info</h3>
                <p className="round-stats__meta">
                  No. of cards:{" "}
                  <strong>{currentRound?.cardsPerPlayer ?? "-"}</strong>
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
                    const wonCount = currentRound.trickHistory.filter(
                      (trick) => trick.winnerId === player.playerId,
                    ).length;
                    return (
                      <div className="round-stats__row" key={player.playerId}>
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
    </>
  );
}
