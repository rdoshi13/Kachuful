# Kachuful (Multiplayer Web Game)

Kachuful is a Gujarati trick-taking card game (related to Oh Hell/Judgment) built as a private multiplayer web app for family play.

## Live App

- Public URL: `https://kachuful-server.rdoshi13.workers.dev`

This URL serves both:
- frontend UI (`GET /`)
- backend APIs + WebSocket events (`/rooms`, `/ws`, etc.)

## Current Status

- Deterministic game engine implemented and tested
- Server-authoritative multiplayer implemented
- Same-device reconnect support implemented
- Trump suit rules implemented
- Match history persisted in backend state
- Cloudflare deployment live

## Project Structure

- `apps/web` - Next.js frontend
- `apps/server` - local Node/Express + Socket.IO server (kept for local/integration workflows)
- `apps/cloudflare-server` - production Cloudflare Worker + Durable Object backend
- `packages/game-engine` - pure reducer game rules/state machine
- `packages/shared-types` - shared contracts/types

## Core Rules (v1)

- Players: 3-6 recommended
- Deck: standard 52-card
- Round pattern:

```text
1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 7 -> 6 -> 5 -> 4 -> 3 -> 2 -> 1
```

- Dealer bids last and cannot make total bids equal cards dealt (compulsory dealer rule)
- 1-card rounds are blind:
  - bid before seeing cards
  - reveal after bids lock
- Follow-suit enforced
- Trump order rotates by round:
  - `Spades -> Diamonds -> Clubs -> Hearts` (repeat)
- Scoring:
  - exact bid: `10 + tricksWon`
  - miss: `0`

## Runtime API (Cloudflare Worker)

- `GET /` - frontend
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

Workflow file:
- `.github/workflows/deploy-cloudflare.yml`

Trigger:
- every push to `main`
- manual dispatch from Actions tab

### One-Time Setup

In GitHub repo:
1. `Settings` -> `Secrets and variables` -> `Actions`
2. Add repository secret `CLOUDFLARE_API_TOKEN`
3. Add repository secret `CLOUDFLARE_ACCOUNT_ID`
   - value: `03fa06c1334ae6ef4fd3aff628ba23a0`

Then push to `main` to trigger deployment.

## Manual Deploy (Fallback)

From repo root:

```bash
NEXT_PUBLIC_API_BASE=https://kachuful-server.rdoshi13.workers.dev \
NEXT_PUBLIC_SOCKET_URL=https://kachuful-server.rdoshi13.workers.dev \
pnpm --filter @kachuful/web build

pnpm --filter @kachuful/cloudflare-server exec wrangler deploy \
  --name kachuful-server \
  --compatibility-date 2026-03-27 \
  --assets ../web/out
```

## Local Development

Install dependencies:

```bash
pnpm install
```

Run frontend locally:

```bash
pnpm --filter @kachuful/web dev
```

Run local Node server (optional):

```bash
pnpm --filter @kachuful/server dev
```

## Testing

```bash
pnpm check
pnpm --filter @kachuful/game-engine test
pnpm --filter @kachuful/web test
pnpm --filter @kachuful/server test
```
