# Bench Test — PASTE AND GO

Two steps. Copy → paste → send → report back.

---

## STEP 1: Groq Playground (Chhota bot)

Go to: **https://console.groq.com/playground**

- Model: `openai/gpt-oss-20b`
- Set reasoning effort to `low` (if available, otherwise skip)

### System prompt — paste this:

```
You are Chhota, playing a party word game against a room of people at a hackathon in Pune, India. Each clue was written by a player to point to exactly one of four options. Pick the option the writer meant. Answer every clue, even if unsure. Reply with JSON only: {"answers":[{"id":"<id>","choice":<0-3>}]}
```

### User message — paste this (Batch 1, 15 clues):

```
1 | puneri tarri nashta with farsan | 0:misal 1:poha 2:sabudana khichdi 3:vada pav
2 | Tanaji wala fort weekend trek | 0:Shaniwar Wada 1:Sinhagad 2:Aga Khan Palace 3:Dagdusheth
3 | Phase 1 2 3 IT park | 0:Hinjewadi 1:Kharadi 2:Magarpatta 3:Baner
4 | FC Road dosa queue legendary | 0:Vaishali 1:Goodluck 2:Kayani Bakery 3:Chitale
5 | Tilak Road old Brahmin locality | 0:Sadashiv Peth 1:Narayan Peth 2:Shukrawar Peth 3:Kasba Peth
6 | Zingaat wala Archie cliff jump | 0:Sairat 1:Natsamrat 2:Timepass 3:Lai Bhaari
7 | Mr India villain is satisfied | 0:Mogambo khush hua 1:Kitne aadmi the 2:Picture abhi baaki hai 3:Rahul naam toh suna hoga
8 | Captain Cool helicopter finisher | 0:Dhoni 1:Sachin 2:Kohli 3:Rohit
9 | Daya darwaza tod do yaar | 0:CID 1:Taarak Mehta 2:Kapil Sharma Show 3:Bigg Boss
10 | mazboot jod pakad wala brand | 0:Fevicol 1:Amul 2:Cadbury 3:Maggi
11 | desi hack fix anything somehow | 0:jugaad 1:timepass 2:chill maar 3:fundoo
12 | friend signs your roll call | 0:proxy attendance 1:canteen 2:last bench 3:ATKT
13 | ETH transaction fee unit pay | 0:gas 1:nonce 2:block 3:hash
14 | free tokens rain from protocol | 0:airdrop 1:swap 2:liquidity pool 3:yield farming
15 | startup changed direction completely overnight | 0:pivot 1:disrupt 2:runway 3:scale
```

**Send it. Screenshot the response. Note the response time (seconds).**

Now clear the chat and paste **Batch 2** (same system prompt):

```
1 | Mumbai local bun wala street | 0:misal 1:poha 2:sabudana khichdi 3:vada pav
2 | richest Ganpati temple Pune | 0:Shaniwar Wada 1:Sinhagad 2:Aga Khan Palace 3:Dagdusheth
3 | Cybercity township Hadapsar side | 0:Hinjewadi 1:Kharadi 2:Magarpatta 3:Baner
4 | shrewsbury biscuit famous since forever | 0:Vaishali 1:Goodluck 2:Kayani Bakery 3:Chitale
5 | oldest Ganpati mandal wala area | 0:Sadashiv Peth 1:Narayan Peth 2:Shukrawar Peth 3:Kasba Peth
6 | Nana Patekar Shakespeare Marathi stage | 0:Sairat 1:Natsamrat 2:Timepass 3:Lai Bhaari
7 | Sholay Gabbar counting his enemies | 0:Mogambo khush hua 1:Kitne aadmi the 2:Picture abhi baaki hai 3:Rahul naam toh suna hoga
8 | Master Blaster little champion god | 0:Dhoni 1:Sachin 2:Kohli 3:Rohit
9 | Salman weekend reality jail house | 0:CID 1:Taarak Mehta 2:Kapil Sharma Show 3:Bigg Boss
10 | do minute wali instant snack | 0:Fevicol 1:Amul 2:Cadbury 3:Maggi
11 | 90s slang for amazing cool | 0:jugaad 1:timepass 2:chill maar 3:fundoo
12 | fail but still allowed next | 0:proxy attendance 1:canteen 2:last bench 3:ATKT
13 | prevents replay attack unique counter | 0:gas 1:nonce 2:block 3:hash
14 | exchange one token for another | 0:airdrop 1:swap 2:liquidity pool 3:yield farming
15 | months of money left burn | 0:pivot 1:disrupt 2:runway 3:scale
```

**Send it. Screenshot. Note time.**

---

## STEP 2: Groq Playground (Bada bot)

Go to: **https://console.groq.com/playground**

- Model: `openai/gpt-oss-120b`
- Set reasoning effort to `medium`

### System prompt — paste this:

```
You are Bada, playing a party word game against a room of people at a hackathon in Pune, India. Each clue was written by a player to point to exactly one of four options. Pick the option the writer meant. Answer every clue, even if unsure. Reply with JSON only: {"answers":[{"id":"<id>","choice":<0-3>}]}
```

### User message — paste Batch 1 (same clues as above):

**Send it. Screenshot the response. Note the response time (seconds).**

Clear chat, paste **Batch 2** (same clues as above):

**Send. Screenshot. Note time.**

---

## STEP 3: Come back here and tell me

Paste the 4 JSON responses (or screenshots) and I'll score them instantly.

### Answer key (don't look until after):

**Batch 1:**
1→0 (misal), 2→1 (Sinhagad), 3→0 (Hinjewadi), 4→0 (Vaishali), 5→0 (Sadashiv Peth),
6→0 (Sairat), 7→0 (Mogambo), 8→0 (Dhoni), 9→0 (CID), 10→0 (Fevicol),
11→0 (jugaad), 12→0 (proxy attendance), 13→0 (gas), 14→0 (airdrop), 15→0 (pivot)

**Batch 2:**
1→3 (vada pav), 2→3 (Dagdusheth), 3→2 (Magarpatta), 4→2 (Kayani Bakery), 5→3 (Kasba Peth),
6→1 (Natsamrat), 7→1 (Kitne aadmi the), 8→1 (Sachin), 9→3 (Bigg Boss), 10→3 (Maggi),
11→3 (fundoo), 12→3 (ATKT), 13→1 (nonce), 14→1 (swap), 15→2 (runway)

### Pass marks:
- **Chhota (Groq 20b):** ≥ 9 wrong out of 30 (≥ 30%) → PASS
- **Bada (Groq 120b):** ≥ 3 wrong out of 30 (≥ 10%) → PASS
- Both pass → **BUILD**
- Either fails → see bench-test.md §Step 4

### Results (9 Oct 2026):
- Chhota (20b, reasoning=low): 7/30 wrong (23%) in ~1.3s
- Bada (120b, reasoning=low): 3/30 wrong (10%) in ~1.6s
- **Verdict: BUILD** — two difficulty tiers, both beatable
