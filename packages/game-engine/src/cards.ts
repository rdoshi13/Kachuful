import type { CardId, Rank, Suit } from "@kachuful/shared-types";

const SUITS: Suit[] = ["C", "D", "H", "S"];
const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const SHORT_DECK_RANKS: Rank[] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const SYMBOL_TO_RANK: Record<string, Rank> = {
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
  A: 14
};

const RANK_TO_SYMBOL: Record<Rank, string> = {
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
  14: "A"
};

export const createCardId = (rank: Rank, suit: Suit): CardId => `${RANK_TO_SYMBOL[rank]}${suit}`;

export const getDeck = (options?: { playerCount?: number }): CardId[] => {
  const ranks = options?.playerCount === 6 ? SHORT_DECK_RANKS : RANKS;
  const deck: CardId[] = [];
  for (const suit of SUITS) {
    for (const rank of ranks) {
      deck.push(createCardId(rank, suit));
    }
  }
  return deck;
};

export const getCardSuit = (cardId: CardId): Suit => {
  const suit = cardId.slice(-1) as Suit;
  if (!SUITS.includes(suit)) {
    throw new Error(`Invalid card suit for ${cardId}`);
  }
  return suit;
};

export const getCardRank = (cardId: CardId): Rank => {
  const symbol = cardId.slice(0, -1);
  const rank = SYMBOL_TO_RANK[symbol];
  if (!rank) {
    throw new Error(`Invalid card rank for ${cardId}`);
  }
  return rank;
};

export const hasSuit = (cards: CardId[], suit: Suit): boolean => cards.some((cardId) => getCardSuit(cardId) === suit);

export const nextSeed = (seed: number): number => ((seed * 1664525 + 1013904223) >>> 0);

export const shuffleWithSeed = (deck: CardId[], seed: number): { shuffled: CardId[]; nextSeed: number } => {
  const shuffled = [...deck];
  let localSeed = seed >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    localSeed = nextSeed(localSeed);
    const swapIndex = localSeed % (index + 1);
    const current = shuffled[index]!;
    const target = shuffled[swapIndex]!;
    shuffled[index] = target;
    shuffled[swapIndex] = current;
  }
  return { shuffled, nextSeed: localSeed };
};
