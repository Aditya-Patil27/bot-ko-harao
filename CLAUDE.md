# Bot ko Harao

Full spec: `_bmad-output/planning-artifacts/bot-ko-harao-spec.md`
Build spec: `docs/spec.md` · Architecture: `docs/architecture.md`

## Five rules

1. **Money moves only by contract rules.** Server proposes, contract verifies. Never `pay(address, amount)` from the server.
2. **No shared hot slots.** Clue IDs = `keccak256(giver, round)`. Guess slots = `(clue, player)`. Counts from events, not storage counters.
3. **Measure gas, never hardcode big limits.** Monad bills the gas *limit*. Use `forge test --gas-report` + 20%.
4. **Server pushes, phones never poll.** One wss subscription fans out. 60 phones must not hammer the RPC.
5. **Degrade, never die on stage.** Bot timeout = wrong answer + "still thinking…". Failed settle retries next round.

## Commands

```bash
# Contract
cd contracts && forge build && forge test
forge test --gas-report

# Server
cd server && pnpm install && pnpm dev
pnpm test

# Frontend
cd web && pnpm install && pnpm dev

# All
npm run build && npm test
```

## Build & test

- ALWAYS run tests after code changes
- ALWAYS verify build succeeds before committing
- Validate input at system boundaries
