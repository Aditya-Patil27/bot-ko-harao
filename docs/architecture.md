# Bot ko Harao — Architecture Overview

**Beat the bot, take its money.** A party word game on Monad where humans earn testnet MON from AI mistakes.

---

## What it is

A room of ~40 people at a hackathon play a word game against two AI bots on their phones. The bots hold real testnet MON. When a human writes a clue that other humans get but the bot doesn't — the bot pays. Everything is onchain: clues, guesses, timing, payouts.

**The twist over normal party games:** a bad clue (too niche, nobody gets it) costs only the writer, never the room. And a clue that's too obvious (the AI gets it) earns nothing. The sweet spot is local, cultural, Hinglish, "you had to be there" clues.

---

## The three pieces

```
  PHONES (/play)              SERVER (Node)                MONAD CHAIN
  ─────────────              ────────────                 ───────────
  burner wallet              game loop                    BotKoHarao.sol
  write clues ──────────▶    moderate + deal  ──────▶     postClue tx
  tap to guess ─────────▶    relay via /rpc   ──────▶     guess tx
                             bots (LLM call)  ──────▶     bot guess txs
  ◀──── WebSocket ─────────  settle           ──────▶     settle tx (payouts)
                             stats

  PROJECTOR (/screen)
  ───────────────────
  QR code, live tiles, bot balances, reveal cards
  ◀──── WebSocket ─────────
```

### 1. Smart contract (`BotKoHarao.sol`)

The only thing that moves money. It stores:
- **Clues** — who wrote it, which round, a commitment to the answer
- **Guesses** — who guessed what, and in which block (the timing proof)
- **Balances** — bots' bankrolls and players' winnings

Key functions:
| Function | Who calls it | What it does |
|---|---|---|
| `postClue` | player phone | Posts a clue with a hidden answer commitment |
| `guess` | player phone / bot | Records a guess + the block number |
| `settle` | server (operator) | Reveals answers, checks commitments, pays winners |
| `fund` | anyone | Tops up a bot's bankroll |
| `dripMany` | server (drip wallet) | Gives gas to new burner wallets |
| `withdraw` | player (not bots) | Cash out winnings |

### 2. Server (Node + TypeScript, single process)

The game brain. Runs locally on the laptop, exposed via cloudflared tunnel.

| File | Job |
|---|---|
| `game.ts` | Phase machine: LOBBY → WRITE → GUESS (4 slots) → REVEAL → loop |
| `deal.ts` | Assigns words from groups to players, creates answer commitments |
| `route.ts` | Assigns clues to guessers: never your own, never from your group |
| `moderate.ts` | Checks clues before they go onchain (length, banned words, option leaks) |
| `chain.ts` | viem clients, local nonce manager, WebSocket log subscription |
| `drip.ts` | Funds new burner wallets via `dripMany`, batched once per second |
| `bots.ts` | Two AI bots, each with its own wallet and LLM client |
| `settle.ts` | Builds settle input from cached events, chunks by gas limit |
| `stats.ts` | Tracks tap-to-block latency, tx/s, block height |
| `mock.ts` | Replays a fake round so the frontend can be built without the chain |

### 3. Frontend (Vite + React + Tailwind)

Two routes in one app:

**`/play` (phone)** — burner key in localStorage, join via QR, write clues, tap to guess, see results. Sends txs through the server's `/rpc` proxy.

**`/screen` (projector)** — QR code, joining names, live clue tiles, bot guess dots with latency, bot balance animation, the three reveal cards, leaderboard, stats footer.

---

## How one round works (~80 seconds)

```
LOBBY ──▶ WRITE (30 s) ──▶ GUESS: 4 slots × 8 s ──▶ REVEAL (15 s) ──▶ LOBBY
```

### WRITE phase (30 seconds)

1. Server deals each player a word from a **group of 4** (e.g. misal / poha / sabudana khichdi / vada pav).
2. Your phone shows YOUR word big, the other three under "not these".
3. You write a ≤6-word clue pointing to yours, not the others. Can't use any of the 4 words.
4. Phone posts it onchain via `postClue` with a commitment to the answer (hash of giver + round + answer + salt). The server holds the salt.

### GUESS phase (4 slots × 8 seconds = 32 seconds)

1. Submitted clues are split into 4 batches (slots).
2. In each slot, every phone gets **one** clue (never your own, never from your group) with the 4 options shuffled.
3. Both bots also get that slot's clues at the same instant.
4. **Chhota Bot** (fast, dumb): makes one batched LLM call, low reasoning, answers in ~1 s, bursts guess txs.
5. **Bada Bot** (slow, smart): makes one batched LLM call, high reasoning, answers in ~5–8 s, bursts guess txs.
6. Every guess is a transaction. The contract records `block.number` — this is the timing proof.

### REVEAL phase (15 seconds)

1. Server sends one `settle` tx that reveals every answer, verifies commitments, checks all guesses.
2. The contract pays winners: **R** MON per bot beaten (wrong or slower block), **G** MON per wrong bot to the clue-giver (if ≥1 human was right).
3. Projector shows three cards:
   - **✅ Beat the bot** — the clue most humans got while both bots missed
   - **⚠️ Too niche** — zero humans got it (writer earns nothing, nobody else lost anything)
   - **⚠️ Too obvious** — a bot got it fast (writer earns nothing)
4. Bot balances animate downward. Leaderboard updates.

---

## The scoring rules

> **Guessers can only win.** A correct guess earns R from each bot it beats.
> Beating a bot = the bot was wrong, or your guess landed in an earlier block.
> Same block = tie → **human wins**.
>
> **The clue-giver earns G per wrong bot, but only if ≥1 human was right.**

| Outcome | Humans | Chhota | Bada | Guesser gets | Giver gets |
|---|---|---|---|---|---|
| **Beat the bot** | 3/4 right | wrong | wrong | 2R = 0.04 | 2G = 0.10 |
| Faster than Bada | 2/4 right | right | right but slower | R from Bada | 0 |
| **Too niche** | 0/4 | wrong | wrong | nothing | 0 |
| **Too obvious** | 4/4 | right | right | R if faster than a bot | 0 |
| Bot timed out | any | no answer | — | counts as bot wrong | — |

R = 0.02 MON, G = 0.05 MON (Standard). Tunable at the 16:15 playtest.

---

## The money flow

```
  Funder ──fund()──▶ BOT BANKROLL (internal balance, onchain)
                          │
       humans beat bot ───┤──▶ guessers get R, clue-givers get G
                          │
       clues that beat it ┘──▶ onchain dataset: clue, answer, options,
                                human guess rate, which bots failed
```

- **Free to play.** Players never stake anything. Bots are funded; humans only earn.
- **Why a chain?** The timing proof (tap → block) and the dataset provenance (signed txs in block order) only work onchain.
- **Who funds?** For the hackathon: us (testnet MON from faucet). The pitch: AI labs fund bots and get back the clues that beat their model.

---

## The bots

| | **Chhota** (fast) | **Bada** (smart) |
|---|---|---|
| Model | `openai/gpt-oss-20b` on Groq | `openai/gpt-oss-120b` on Groq |
| Reasoning | `low` | `low` |
| Response time | ~1.3 s | ~1.6 s |
| Timeout | 4 s | 8 s |
| How humans beat it | Local/cultural knowledge (23% wrong on bench) | Knowledge — smarter but still 10% wrong; slightly slower |
| Personality | Overconfident, Mumbai-speed | Thinks hard, Puneri-sarcastic |

Both bots on Groq, both use OpenAI-compatible chat-completions. Free tier, no card. Separate TPM limits per model (~70K tokens/evening out of 200K TPD each). One batched call per slot (all clues at once). Env-configurable: swap a provider by changing `.env`.

**Fallback — two local LLM routers (run both before hack day):**

| Router | Endpoint | What it does |
|---|---|---|
| [OmniRoute](https://github.com/diegosouzapw/omniroute) | `localhost:20128` | 90+ free providers, 500+ models, 18-strategy failover |
| [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) | `localhost:3000` | 34 providers, smart routing, quota tracking |

If Groq dies mid-demo → swap `BASE_URL` to OmniRoute. If OmniRoute is also down → swap to FreeLLMAPI. Last resort → Ollama on the laptop. Each swap is one env var change + server restart.

---

## Monad-specific things that matter

| What | Why |
|---|---|
| 300 ms blocks | The tap-to-block race is the core mechanic |
| `block.number` not `timestamp` | Timestamps have 1 s granularity; 3–4 blocks share one |
| Parallel-friendly storage | Per-player slots, clue IDs from keccak(giver, round), no global counters |
| `eth_sendRawTransactionSync` | One call returns the receipt → measurable latency |
| wss logs at Proposed | Projector tiles update ~300 ms after a tap |
| Internal balances | Payouts in `settle` avoid the 10 MON reserve-balance rule |
| Measured gas limits | Monad bills the gas limit, not gas used; a lazy 5M limit costs 0.5 MON per tx |

---

## Key design rules (§8)

1. **Money moves only by contract rules.** Server proposes, contract verifies.
2. **No shared hot slots.** Per-player storage, no `nextId++`.
3. **Measure gas, never hardcode big limits.** `forge test --gas-report` + 20%.
4. **Server pushes, phones never poll.** One wss subscription fans out to all clients.
5. **Degrade, never die on stage.** Bot timeout = wrong answer + "still thinking…".
