# Kachuful (Multiplayer Web Game)

Kachuful is a Gujarati trick-taking card game related to **Oh Hell**, **Judgment**, and **Forecasting**. This repository is for a private multiplayer web version so family members in different countries can play together in real time.

The game is turn-based, so correctness and reliability are more important than ultra-low latency.

## Project Goals

- Build a deterministic multiplayer Kachuful engine.
- Keep the server authoritative for all game state.
- Ship a simple, mobile-friendly web UI.
- Keep logic modular and testable.

## Core Rules

### Players and Deck

- Recommended players: 3-6
- Private rooms with code/link join
- Standard 52-card deck

### Round Pattern

Cards per player follow this sequence:

```text
1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 7 -> 6 -> 5 -> 4 -> 3 -> 2 -> 1
```

Example: in round `1`, each player gets 1 card; in round `8`, each gets 8 cards; then the count decreases back to 1.

### Dealer and Compulsory Rule

- Dealer rotates clockwise each round.
- Dealing starts from the player after the dealer.
- Dealer bids last.
- Dealer is bound by the compulsory rule: total bids must **not** equal the cards dealt in that round.

Example: if the round has 5 cards and earlier bids sum to 3, dealer cannot bid 2.

### Blind Round (1 Card)

In 1-card rounds:

- Players bid before seeing their card.
- Cards are revealed only after all bids are locked.
- Trick play then proceeds normally.

### Bidding

- Bidding starts from the player clockwise after dealer and ends with dealer.
- Valid bids are `0..cardsPerPlayer`, except the dealer restriction above.

### Trick Play

- First player leads a card.
- Players must follow suit if possible.
- If unable to follow suit, any card may be played.
- Highest card in the lead suit wins the trick.
- Winner leads next trick.
- Optional variant: trump suit support.

### Scoring

- Exact bid match: `score = 10 + tricksWon`
- Missed bid: `score = 0`
- Total score is cumulative across rounds.
- Highest final score wins.

## Multiplayer Requirements

- Reliable state synchronization
- Reconnection support
- Deterministic server-side rule enforcement
- Low bandwidth usage
- Persistent completed-match history across server restarts

Because gameplay is turn-based, moderate network latency is acceptable.

## Architecture Direction

### Authoritative Server Model

Clients send only player intent, not state mutations.

Example:

```json
{ "type": "play_card", "cardId": "..." }
```

Server validates intent, updates canonical state, and broadcasts the result.

### Suggested MVP Stack

- Frontend: Next.js + React + Tailwind CSS
- Backend: Node.js + Express + Socket.IO
- State (MVP): in-memory room/session state + persisted JSON match history
- Future: Redis (distributed room state), Postgres (history/analytics)

## Core State Shape

```text
Game
  players
  scores
  roundNumber
  dealerIndex
  currentPhase

Round
  cardsPerPlayer
  trumpSuit
  bids
  tricksWon
  hands
  trickHistory
  currentTrick
  currentPlayer
```

## Phase Model

Engine should be implemented as a finite state machine:

```text
lobby
round_setup
bidding
reveal_hands_if_needed
trick_play
round_scoring
next_round
game_complete
```

Blind round path:

```text
shuffle -> bidding -> reveal_cards -> play_trick
```

## Reconnection

On reconnect, server should restore:

- player seat/session identity
- hand visibility for that player
- current public game state

Game should continue safely without desynchronization.

## MVP Scope

### Include in v1

- create room
- join room by code
- player name selection
- start game flow
- bidding UI
- hand/table trick UI
- scoreboard
- reconnect support

### Not Required Initially

- chat
- emojis/reactions
- accounts
- avatars
- matchmaking

## Engineering Priority Order

1. Deterministic game engine
2. Multiplayer synchronization
3. UI rendering and usability
4. Reconnection reliability

If priorities conflict, prefer rule correctness over UI complexity.

## Server Persistence (MVP)

- Completed matches are written to a JSON file (default: `.data/match-history.json`).
- Override path with `MATCH_HISTORY_FILE=/absolute/path/to/history.json`.
- Read room history via `GET /rooms/:code/history`.
