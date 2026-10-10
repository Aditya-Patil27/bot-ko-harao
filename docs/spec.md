# Bot ko Harao — Technical Build Spec

Build reference for Claude Code sessions. Points at the full spec in `_bmad-output/planning-artifacts/bot-ko-harao-spec.md` for context; this file has the interfaces.

---

## Contract: `BotKoHarao.sol`

### Storage

```solidity
struct Clue {                 // packed into 2 slots
    address giver;            // slot 0: 20 bytes
    uint32  round;            //         4
    uint16  group;            //         2
    bool    settled;          //         1
    bytes32 commit;           // slot 1: keccak256(abi.encode(giver, round, answer, salt))
}

mapping(bytes32 => Clue) public clues;                          // clueId = keccak256(abi.encode(giver, round))
mapping(bytes32 => mapping(address => uint256)) public guessOf; // (block.number << 8) | (choice + 1); 0 = none
mapping(address => uint256) public balanceOf;                   // bots' bankrolls + players' winnings
address[2] public bots;
uint256 public R;   // per human, per beaten bot
uint256 public G;   // per wrong bot, to the giver, if ≥1 human right
address public operator;
```

### Functions

```solidity
// players
function postClue(uint32 round, uint16 group, bytes32 commit, string calldata text) external;
function guess(bytes32 clueId, uint8 choice) external;         // choice 0..3, canonical group order
function withdraw() external;                                   // bots cannot withdraw

// sponsors (anyone)
function fund(address bot) external payable;

// operator
function settle(Settlement[] calldata items) external;
function dripMany(address[] calldata to, uint256 each) external payable;

struct Settlement { bytes32 clueId; uint8 answer; bytes32 salt; address[] winners; } // winners sorted ascending
```

### Events

```solidity
event ClueGiven(bytes32 indexed clueId, address indexed giver, uint32 round, uint16 group, string text);
event Guessed  (bytes32 indexed clueId, address indexed player, uint8 choice, uint64 blockNo);
event Settled  (bytes32 indexed clueId, uint8 answer, uint8 humansRight, uint8 botsRightMask);
event Paid     (bytes32 indexed clueId, address indexed from, address indexed to, uint256 amount, uint8 reason);
event Funded   (address indexed from, address indexed bot, uint256 amount);
```

### `guess` rules

- Clue exists and not settled
- Sender is not the giver
- `choice < 4`
- No earlier guess from this sender on this clue
- Store: `(block.number << 8) | (choice + 1)` in one slot

### `settle` logic per item

```
c = clues[id]
require: exists && !settled
require: keccak256(abi.encode(c.giver, c.round, answer, salt)) == c.commit

for each bot b:
    g = guessOf[id][b]
    botBlock[b] = (g != 0 && choice(g) == answer) ? blk(g) : MAX

prev = 0
for each h in winners:
    require h > prev (sorted, no duplicates)
    require h != c.giver && h is not a bot
    g = guessOf[id][h]
    require g != 0 && choice(g) == answer
    for each bot b:
        if blk(g) <= botBlock[b] → pay(b → h, R)    // same block → human wins

if winners.length > 0:
    for each bot b with botBlock[b] == MAX → pay(b → c.giver, G)

c.settled = true
emit Settled

pay(): if bot balance < amount → pay what's left ("BOT BROKE")
```

### Foundry tests to write first

One per row of the scoring table, plus:
- Wrong commit → revert
- Non-winner in `winners` → revert
- Unsorted or duplicate winner → revert
- Giver guessing own clue → revert
- Double guess → revert
- Guess after settle → revert
- Bot calling `withdraw` → revert
- Empty bankroll → partial pay
- Same-block tie → human is paid (`vm.roll`)

### Foundry config

```toml
# foundry.toml
[profile.default]
solc_version = "0.8.28"

[etherscan]
monad = { key = "", url = "https://sourcify.blockvision.org/server" }

[rpc_endpoints]
monad = "${MONAD_RPC_HTTP}"
```

---

## Server endpoints

| Endpoint | In | Out | Validation |
|---|---|---|---|
| `POST /join` | `{name, address}` | `{playerId, config}` | Name 1–16 chars `[A-Za-z0-9 _-]`; valid checksummed address; one per address; global cap. No per-IP rate limit (venue shares one NAT). |
| `POST /clue/check` | `{text}` | `{ok, reason?}` | ≤ 40 chars, ≤ 6 words; none of the 4 options or stems (case-insensitive); wordlist |
| `POST /rpc` | JSON-RPC | passthrough | Allowlist: `eth_sendRawTransactionSync`, `eth_sendRawTransaction`, `eth_chainId`. Decode raw tx: `to == CONTRACT`, `value == 0`. 4 KB body cap. |
| `POST /stat` | `{ms, kind}` | — | Clamp to 0–30,000 |

## WebSocket messages

### Server → phone

| Message | Payload | When |
|---|---|---|
| `hello` | `{config, gas}` | On connect |
| `phase` | `{name, round, endsAt}` | Phase change |
| `deal` | `{round, group, options[4], mine, commit}` | WRITE start |
| `slot` | `{round, slot, clueId, text, options[4], endsAt}` | Each GUESS slot |
| `result` | `{payouts[], balance}` | After settle |

### Server → projector

| Message | Payload | When |
|---|---|---|
| `phase` | `{name, round, endsAt}` | Phase change |
| `players` | `{count, names[]}` | Player joins |
| `clue` | `{clueId, text}` | After moderation passes |
| `guess` | `{clueId, who, ms, block}` | Each guess lands (no correctness until reveal) |
| `bot` | `{name, balance, thinkMs}` | Bot action |
| `reveal` | `{cards[], leaderboard[], beatCount}` | After settle |
| `stats` | `{block, txps, p50, p95}` | Periodic |

---

## Game state machine

```
LOBBY → WRITE (30 s) → GUESS (4 slots × 8 s) → REVEAL (15 s) → LOBBY
```

`DEMO_MODE=1`: WRITE 25 s, 3 slots × 7 s.

### Phase transitions

- **LOBBY → WRITE**: ≥ 3 players, operator presses N (or auto if always-on)
- **WRITE → GUESS**: timer expires. Server splits submitted clues into 4 slot batches.
- **GUESS slot → next slot**: timer expires. Both bots get the new batch.
- **Last slot → REVEAL**: server sends `settle` tx.
- **REVEAL → LOBBY**: settle confirms + 15 s animation.

---

## Bot integration (`bots.ts`)

```
Per bot:
  - OpenAI-compatible client from BOT_*_BASE_URL / API_KEY / MODEL
  - On each slot: one batched LLM call with all live clues
  - System prompt: §13.2 (see docs/bench-test.md for exact text)
  - User message: "id | clue | 0:opt 1:opt 2:opt 3:opt" per line
  - Parse response: take first {...} in reply, extract answers array
  - Timeouts: Chhota 4 s, Bada 12 s (timeout = no answer = wrong)
  - Both bots on Groq (gpt-oss-20b + gpt-oss-120b), same API key, separate TPM limits
  - Burst guess txs with local nonces
  - Report thinkMs and landed block to the projector
```

No provider SDKs. No Anthropic. One `openai` npm client per bot.

### Fallback: two local LLM routers

Run **both** before hack day. If a primary provider dies, swap to a router. If that router is also down, swap to the other.

| Router | Install | Endpoint | Providers |
|---|---|---|---|
| **OmniRoute** | `npm install -g omniroute && omniroute` | `http://localhost:20128/v1` | 90+ free, 500+ models, 18-strategy failover |
| **FreeLLMAPI** | `git clone https://github.com/tashfeenahmed/freellmapi` + `docker compose up` | `http://localhost:3000/v1` | 34 providers, smart routing, quota tracking |

Both are self-hosted, OpenAI-compatible, MIT-licensed. They aggregate free tiers with automatic failover across providers.

**Pre-event setup (tonight):**
1. Install both. OmniRoute needs `INITIAL_PASSWORD` set on first run.
2. Send a test prompt to each: `curl http://localhost:20128/v1/chat/completions -H "Authorization: Bearer $KEY" -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'`
3. Note which models each router exposes and their latency.

**Swap procedure on stage (10 seconds):**
1. In `.env`, change `BOT_CHHOTA_BASE_URL=http://localhost:20128/v1` (OmniRoute) or `http://localhost:3000/v1` (FreeLLMAPI)
2. Set `BOT_CHHOTA_MODEL=` to a model the router exposes, or leave blank for auto-route
3. Restart server

**Failover ladder:**

| Try | Chhota | Bada |
|---|---|---|
| 1 | Groq `gpt-oss-20b` (reasoning=low) | Groq `gpt-oss-120b` (reasoning=low) |
| 2 | OmniRoute (`localhost:20128`) | OmniRoute |
| 3 | FreeLLMAPI (`localhost:3000`) | FreeLLMAPI |
| 4 | Ollama `qwen3:8b` on the laptop | Ollama |

You lose model control on routers, so bench test results won't hold — but a working bot on a random free model beats a dead bot on stage.

---

## Monad-specific

| What | How | Why |
|---|---|---|
| Block timing | `block.number` from the guess storage, never `block.timestamp` | 1 s timestamp granularity; 3–4 blocks share one |
| Gas limits | `forge test --gas-report` + 20% headroom. ~65k guess, ~80k postClue **[measure]** | Monad bills the gas *limit*, not used. Lazy 5M = 0.5 MON |
| Receipt | `eth_sendRawTransactionSync` via `/rpc` proxy | One call returns receipt at Proposed |
| Live display | wss `logs` subscription at Proposed state | Tiles light up ~300 ms after tap |
| Internal balances | `balanceOf` mapping; `settle` does internal transfers | Avoids 10 MON reserve-balance rule on payouts |
| Batched drip | `dripMany` once per second, groups joiners | 40 people scan → all funded in 1 s |
| Parallel storage | clueId = keccak256(giver, round); guess slot = (clueId, player) | No shared counters, no contention |
| Nonces | Local nonce manager per role (bots, operator, drip). Resync from `latest` on error. | Burst txs land in 1–2 blocks |

---

## Failure modes

| Failure | What happens |
|---|---|
| LLM call slow / failed | Bot doesn't answer → counts as wrong. Projector: "still thinking…" |
| Phone send fails | One retry → "missed this one" (no penalty) |
| wss drops | Reconnect + backfill with `eth_getLogs` (≤ 100 blocks) |
| Settle reverts | Log, retry with fresh nonce, or carry to next round |
| Player didn't submit clue | They still guess. Routing uses only landed clues. |
| < 3 players | Can't start. Lobby shows "need 3". |
| Tunnel URL changes | Projector QR reads `PUBLIC_URL` live; players rescan |
| Both bots time out 2 slots running | Pause rounds (hotkey) — don't let the room farm the bankroll |
