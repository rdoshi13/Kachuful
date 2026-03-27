# AGENTS.md (Repository-Specific)

This file defines agent guidance for the Kachuful repository. It extends the global `~/.codex/AGENTS.md`.

## Project Context

- Repository purpose: private multiplayer web implementation of Kachuful.
- Current status: early-stage repository (currently documentation-first).
- Source of truth for product/rules: `README.md`.

## Core Working Rules

- Keep changes minimal and focused on the requested task.
- Preserve existing structure and style; avoid unrelated refactors.
- Avoid new dependencies unless clearly necessary.
- Before substantial edits, state a short implementation approach.

## Game-Specific Constraints

- Server must be authoritative; clients send intent only.
- Game logic must be deterministic and replay-safe.
- Enforce bidding/trick/scoring rules exactly as documented.
- If rules and UI convenience conflict, prioritize rule correctness.
- Design for safe reconnection and state restoration.

## Implementation Priorities

1. Deterministic game engine/state machine
2. Multiplayer synchronization correctness
3. Clear, mobile-friendly UI
4. Reconnection resilience

## Testing Expectations

- Add or update tests for any behavior change.
- Prefer narrow deterministic tests first (especially pure game-engine tests).
- Run the smallest relevant checks first, then broader suites.
- If tests/checks cannot run (missing toolchain/scripts), state that clearly.

## Stack And Commands

- No build/test toolchain is defined yet in this repository.
- Before running commands, inspect repo markers (`package.json`, `pyproject.toml`, `go.mod`, etc.).
- Once toolchain exists, use documented project commands and keep this section updated.

## Documentation And APIs

- Verify uncertain framework/SDK behavior from authoritative docs.
- Use Context7 when external API usage is uncertain.
- Do not rely on memory for version-sensitive API details.

## PR/Change Summary Expectations

- Summarize what changed and why.
- Call out assumptions, risks, and concrete next steps when relevant.
