import React from "react";

const SUIT_SYMBOL: Record<string, string> = {
  C: "♣",
  D: "♦",
  H: "♥",
  S: "♠"
};

const normalizeRank = (raw: string): string => {
  if (raw === "T") {
    return "10";
  }
  return raw;
};

export function PlayingCard({ cardId }: { cardId: string }) {
  const suit = cardId.slice(-1).toUpperCase();
  const rawRank = cardId.slice(0, -1).toUpperCase();
  const rank = normalizeRank(rawRank);
  const symbol = SUIT_SYMBOL[suit] ?? "?";
  const isRed = suit === "H" || suit === "D";

  return (
    <span className={`playing-card-face ${isRed ? "playing-card-face--red" : "playing-card-face--black"}`}>
      <span className="playing-card-face__corner">
        <span>{rank}</span>
        <span>{symbol}</span>
      </span>
      <span className="playing-card-face__center">{symbol}</span>
      <span className="playing-card-face__corner playing-card-face__corner--bottom">
        <span>{rank}</span>
        <span>{symbol}</span>
      </span>
    </span>
  );
}
