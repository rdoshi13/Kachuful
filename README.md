# Kachuful (Multiplayer Web Game)

Kachuful is a Gujarati trick-taking card game (related to Oh Hell/Judgment) built as a private multiplayer web app for family play.

## Live Endpoints

- Frontend (Vercel): `https://play.rishabhdoshi.me` (target custom subdomain)
- Backend (Cloudflare Worker): `https://kachuful-server.rdoshi13.workers.dev`

## Current Status

- Deterministic engine with tests
- Server-authoritative multiplayer
- Same-device reconnect support
- Trump suit gameplay
- Persistent match history
- Split deploy model:
  - frontend on Vercel
  - backend on Cloudflare Workers

## Project Structure

- `apps/web` - Next.js frontend
- `apps/server` - local Node/Express + Socket.IO server
- `apps/cloudflare-server` - production Cloudflare Worker + Durable Object backend
- `packages/game-engine` - pure reducer game rules/state machine
- `packages/shared-types` - shared contracts/types

## Core Rules (v1)

- Players: `2-6` (recommended `3-6`)
- Round pattern:

```text
1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 7 -> 6 -> 5 -> 4 -> 3 -> 2 -> 1
```

- Deck:
  - `2-5 players`: full 52-card deck
  - `6 players`: 48-card short deck (all `2`s removed)
- Dealer bids last and cannot make total bids equal cards dealt
- 1-card rounds are blind (bid first, reveal after bids lock)
- Follow-suit enforced
- Trump order rotates by round: `Spades -> Diamonds -> Clubs -> Hearts` (repeat)
- Scoring:
  - exact bid: `10 + tricksWon`
  - miss: `0`

## Backend API (Cloudflare Worker)

- `GET /health` - health check
- `POST /rooms` - create room
- `POST /rooms/:code/join` - join room
- `GET /rooms/:code/history` - room history
- `GET /ws` - WebSocket endpoint

WebSocket message envelope:

```json
{ "event": "event:name", "payload": {} }
```

## Auto Deploy (GitHub Actions)

Workflows:
- `.github/workflows/deploy-cloudflare.yml` - deploys backend only
- `.github/workflows/deploy-vercel.yml` - deploys frontend only

Triggers:
- push to `main`
- manual dispatch

### Required GitHub Secrets

Add under `Settings -> Secrets and variables -> Actions`:

Cloudflare:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID` (`03fa06c1334ae6ef4fd3aff628ba23a0`)

Vercel:
- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

### Required Vercel Project Environment Variables

Set these in Vercel Project Settings:

- `NEXT_PUBLIC_API_BASE=https://kachuful-server.rdoshi13.workers.dev`
- `NEXT_PUBLIC_SOCKET_URL=https://kachuful-server.rdoshi13.workers.dev`
- `NEXT_PUBLIC_SOCKET_TRANSPORT=ws`

## Manual Deploy (Fallback)

Backend only:

```bash
pnpm --filter @kachuful/cloudflare-server exec wrangler deploy \
  --name kachuful-server \
  --compatibility-date 2026-03-27
```

Frontend only (from `apps/web`):

```bash
pnpm dlx vercel pull --yes --environment=production --token="$VERCEL_TOKEN"
pnpm dlx vercel build --prod --token="$VERCEL_TOKEN"
pnpm dlx vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"
```

## Local Development

Install dependencies:

```bash
pnpm install
```

Run local backend:

```bash
pnpm --filter @kachuful/server dev
```

Run frontend against local backend:

```bash
NEXT_PUBLIC_API_BASE=http://localhost:4000 \
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000 \
pnpm --filter @kachuful/web dev
```

Run frontend against cloud backend:

```bash
NEXT_PUBLIC_API_BASE=https://kachuful-server.rdoshi13.workers.dev \
NEXT_PUBLIC_SOCKET_URL=https://kachuful-server.rdoshi13.workers.dev \
pnpm --filter @kachuful/web dev
```

## Testing

```bash
pnpm check
pnpm --filter @kachuful/game-engine test
pnpm --filter @kachuful/web test
pnpm --filter @kachuful/server test
```
