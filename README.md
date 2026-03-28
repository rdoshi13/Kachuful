# Kachuful (Multiplayer Card Game)

Kachuful is a Gujarati trick-taking game (similar to Oh Hell/Judgment).  
This project is a private multiplayer web version where players can create a room, join with a code, bid each round, play tricks, and track score until the game ends.

Live app:
- `https://play.rishabhdoshi.me`

## Tech Stack

- Frontend: Next.js + React + TypeScript
- Backend (prod): Cloudflare Worker + Durable Objects + WebSocket
- Backend (local): Node.js + Express + Socket.IO
- Shared game logic: pure TypeScript reducer engine
- Monorepo: pnpm workspaces

## Features Implemented

- Room create/join flow with room code
- Server-authoritative multiplayer
- Reconnect support on refresh (same device/session)
- Deterministic game engine with tests
- Round flow: `1 -> 2 -> ... -> 8 -> ... -> 1`
- Trump suit rotation: `Spades -> Diamonds -> Clubs -> Hearts`
- Compulsory dealer bid restriction
- Blind 1-card rounds
- Follow-suit enforcement
- Trick winner resolution with trump support
- Round tracker and scoreboard UI
- Match history persistence
- 6-player short-deck handling (all `2`s removed)

## Local Development

Install dependencies:

```bash
pnpm install
```

Run backend locally:

```bash
pnpm --filter @kachuful/server dev
```

Run frontend locally (against local backend):

```bash
NEXT_PUBLIC_API_BASE=http://localhost:4000 \
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000 \
pnpm --filter @kachuful/web dev
```
