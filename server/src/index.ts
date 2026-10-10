import express from 'express';
import { createServer } from 'http';
import { dirname, resolve } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { fileURLToPath } from 'url';
import { encodeFunctionData, formatEther, getAddress, isAddress, parseEventLogs, type Address, type Hex } from 'viem';
import { config } from './config.js';
import { game, type SlotData } from './game.js';
import { dealRound, clueId, nextFreeRound } from './deal.js';
import { moderateClue } from './moderate.js';
import { runBot, type BotResult } from './bots.js';
import { initWs, onIdentify, broadcastToAll, broadcastToProjector, sendToPlayer } from './ws.js';
import {
  abi,
  badaWallet,
  chainEnabled,
  chhotaWallet,
  clueOnChain,
  contract,
  getFees,
  getGameBalance,
  getTxCount,
  guessOnChain,
  operatorWallet,
  PHONE_GAS,
  relayRaw,
  resetNonce,
  sendSettle,
  waitLanded,
} from './chain.js';
import { checkRawTx } from './relay.js';
import { queueDrip } from './drip.js';
import {
  beatTheBots,
  buildSettlement,
  leaderboard,
  outcomes,
  payoutLines,
  pickCards,
  type GuessBook,
  type HumanGuess,
  type Payment,
  type SettleItem,
} from './settle.js';

const app = express();
app.use(express.json({ limit: '4kb' }));

const server = createServer(app);
initWs(server);

// Contract order: bots[0] is Chhota, bots[1] is Bada.
const BOTS = [
  { name: config.botChhota.name, address: chhotaWallet?.account.address },
  { name: config.botBada.name, address: badaWallet?.account.address },
];
const BOT_NAMES = BOTS.map((b) => b.name);
const BOT_ADDRESSES = BOTS.flatMap((b) => (b.address ? [b.address] : []));

function botName(address: string): string {
  return BOTS.find((b) => b.address?.toLowerCase() === address.toLowerCase())?.name ?? 'a bot';
}

let currentDeals = new Map<string, ReturnType<typeof dealRound>[0]>();
// Replaced, not cleared, each round: a settlement still running keeps the books it started with.
let humanGuesses: GuessBook = new Map();
let botAnswers = new Map<string, Map<string, number>>(); // clueId → (bot name → choice)
const pendingClues = new Set<string>();

// Transactions still on the wire. Settlement gives them a moment to land.
const inflight = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
}

// --- WS identify ---

onIdentify((ws, playerId) => {
  const player = game.players.get(playerId);
  if (!player) return;
  player.ws = ws;
  // A phone that reconnects mid-WRITE still needs its cards.
  const deal = currentDeals.get(playerId);
  if (game.phase === 'WRITE' && deal) {
    sendToPlayer(ws, 'deal', {
      round: game.round,
      group: deal.group,
      options: deal.options,
      mine: deal.myIndex,
      commit: deal.commit,
    });
  }
});

// --- Chain helpers ---

// Each burner's nonce when this server first saw it. Above zero, the burner played
// before a restart and may hold clues under round numbers this server would reuse.
const firstNonce = new Map<Address, number>();
// What such a burner already held in the contract, so its phone still shows its full balance.
const heldBefore = new Map<string, bigint>();

// What a phone needs to sign its own transactions. Null means it plays off chain.
async function chainInfo(address: Address) {
  if (!chainEnabled) return null;
  try {
    const [fees, nonce] = await Promise.all([getFees(), getTxCount(address)]);
    if (!firstNonce.has(address)) {
      firstNonce.set(address, nonce);
      if (nonce > 0) heldBefore.set(address, await getGameBalance(address).catch(() => 0n));
    }
    return {
      id: config.chainId,
      contract,
      gas: { postClue: PHONE_GAS.postClue.toString(), guess: PHONE_GAS.guess.toString() },
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      nonce,
    };
  } catch (e) {
    console.error('[chain] could not build phone config:', e);
    return null;
  }
}

// Relays a checked transaction. `landed` is false when it reverted or no receipt
// came back; `nonce` is what the phone should sign with next.
async function relay(serialized: Hex, signer: Address, txNonce: number) {
  try {
    const sent = await track(relayRaw(serialized));
    return { landed: sent.ok, block: sent.block, nonce: txNonce + 1 };
  } catch (e: any) {
    console.error(`[relay] ${signer}: ${e?.shortMessage ?? e?.message ?? e}`);
    const nonce = await getTxCount(signer).catch(() => txNonce);
    return { landed: false, block: 0, nonce };
  }
}

// --- HTTP routes ---

function playerNames() {
  return [...game.players.values()].map((p) => p.name);
}

app.post('/join', async (req, res) => {
  const { name: rawName, address: rawAddress } = req.body;
  if (!rawName || !rawAddress) return res.status(400).json({ error: 'name and address required' });
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!/^[A-Za-z0-9 _-]{1,16}$/.test(name)) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (typeof rawAddress !== 'string' || !isAddress(rawAddress, { strict: false })) {
    return res.status(400).json({ error: 'invalid address' });
  }
  const address = getAddress(rawAddress);

  const existing = game.players.get(address);
  if (existing) {
    queueDrip(address);
    return res
      .status(409)
      .json({ error: 'already joined', playerId: address, name: existing.name, chain: await chainInfo(address) });
  }

  const ok = game.addPlayer({ id: address, name, address, ws: null });
  if (!ok) return res.status(409).json({ error: 'room is full' });

  queueDrip(address);
  broadcastToProjector('players', { count: game.playerCount, names: playerNames() });

  res.json({
    playerId: address,
    config: {
      writeS: config.writeS,
      slotS: config.slotS,
      slots: config.slots,
    },
    chain: await chainInfo(address),
  });
});

app.post('/clue/check', (req, res) => {
  const { text, options } = req.body;
  if (!text || !options) return res.status(400).json({ error: 'text and options required' });
  const result = moderateClue(text, options);
  res.json(result);
});

app.get('/state', (_req, res) => {
  res.json({
    phase: game.phase,
    round: game.round,
    endsAt: game.endsAt,
    playerCount: game.playerCount,
    names: playerNames(),
    publicUrl: config.publicUrl,
  });
});

let starting = false;

// A round number is skipped when a burner in the room already has a clue under it
// on the contract; that clue would block the new one and every guess on it.
app.post('/start', async (_req, res) => {
  if (!starting && game.phase === 'LOBBY' && game.playerCount >= 3) {
    starting = true;
    try {
      const back = [...game.players.keys()].filter((a) => (firstNonce.get(a as Address) ?? 0) > 0);
      const next = game.round + 1;
      game.startRound(back.length ? await nextFreeRound(next, back, clueOnChain) : next);
    } finally {
      starting = false;
    }
  }
  res.json({ ok: true, round: game.round });
});

// With `rawTx` (the phone's signed postClue) the clue goes on chain first. Without
// it, or with no contract configured, the clue is played off chain and pays nothing.
app.post('/clue/submit', async (req, res) => {
  const { playerId, text, rawTx } = req.body;
  if (typeof playerId !== 'string' || typeof text !== 'string' || !playerId || !text)
    return res.status(400).json({ error: 'playerId and text required' });
  if (game.phase !== 'WRITE') return res.status(400).json({ error: 'not in write phase' });

  const deal = currentDeals.get(playerId);
  if (!deal) return res.status(400).json({ error: 'no deal for this player' });

  const round = game.round;
  const id = clueId(playerId, round);
  if (pendingClues.has(playerId) || game.clues.some((c) => c.clueId === id))
    return res.status(409).json({ error: 'already submitted', clueId: id });

  const mod = moderateClue(text, deal.options);
  if (!mod.ok) return res.status(400).json({ error: mod.reason });

  let onChain = false;
  let nonce: number | undefined;
  if (chainEnabled && rawTx !== undefined) {
    pendingClues.add(playerId);
    try {
      const check = await checkRawTx(rawTx, {
        from: playerId as Address,
        to: contract,
        chainId: config.chainId,
        data: encodeFunctionData({
          abi,
          functionName: 'postClue',
          args: [round, deal.group, deal.commit, text],
        }),
        maxGas: PHONE_GAS.postClue,
      });
      if (!check.ok) return res.status(400).json({ error: check.reason });
      const sent = await relay(check.serialized, playerId as Address, check.nonce);
      nonce = sent.nonce;
      // A relay that timed out may still have landed; the chain has the last word.
      onChain = sent.landed || (await clueOnChain(id, deal.commit));
    } finally {
      pendingClues.delete(playerId);
    }
    if (!onChain) return res.status(502).json({ error: 'tx failed', nonce });
    if (game.phase !== 'WRITE' || game.round !== round)
      return res.status(400).json({ error: 'not in write phase', nonce });
  }

  game.addClue({
    clueId: id,
    giver: playerId,
    round,
    group: deal.group,
    text,
    answer: deal.myIndex,
    salt: deal.salt,
    commit: deal.commit,
    options: deal.options,
    onChain,
  });
  broadcastToProjector('clue', { count: game.clues.length, who: game.players.get(playerId)?.name });
  res.json({ ok: true, clueId: id, onChain, nonce });
});

// Same rule as clues: a signed guess on an on-chain clue is relayed and can win
// MON; anything else is counted for the reveal only.
app.post('/guess', async (req, res) => {
  const { playerId, clueId: cid, choice, rawTx } = req.body;
  if (!playerId || !cid || choice === undefined)
    return res.status(400).json({ error: 'playerId, clueId, choice required' });
  if (game.phase !== 'GUESS')
    return res.status(400).json({ error: 'not in guess phase' });
  if (!Number.isInteger(choice) || choice < 0 || choice > 3)
    return res.status(400).json({ error: 'invalid choice' });
  const player = typeof playerId === 'string' ? game.players.get(playerId) : undefined;
  if (!player) return res.status(400).json({ error: 'unknown player' });
  const clue = typeof cid === 'string' ? game.clues.find((c) => c.clueId === cid) : undefined;
  if (!clue) return res.status(400).json({ error: 'unknown clue' });
  if (clue.giver === player.address) return res.status(400).json({ error: 'own clue' });

  let forClue = humanGuesses.get(clue.clueId);
  if (!forClue) humanGuesses.set(clue.clueId, (forClue = new Map()));
  if (forClue.has(player.address)) return res.status(409).json({ error: 'already guessed' });
  // Recorded before the relay so a second tap cannot send a second transaction.
  const record: HumanGuess = { choice, onChain: false };
  forClue.set(player.address, record);

  if (!chainEnabled || !clue.onChain || rawTx === undefined) {
    broadcastToProjector('guess', { clueId: clue.clueId, who: player.name });
    return res.json({ ok: true });
  }

  const check = await checkRawTx(rawTx, {
    from: player.address as Address,
    to: contract,
    chainId: config.chainId,
    data: encodeFunctionData({ abi, functionName: 'guess', args: [clue.clueId as Hex, choice] }),
    maxGas: PHONE_GAS.guess,
  });
  if (!check.ok) {
    forClue.delete(player.address);
    return res.status(400).json({ error: check.reason });
  }

  const started = Date.now();
  const sent = await relay(check.serialized, player.address as Address, check.nonce);
  const ms = Date.now() - started;
  if (!sent.landed) {
    const landedChoice = await guessOnChain(clue.clueId as Hex, player.address as Address);
    if (landedChoice === null) {
      forClue.delete(player.address);
      return res.status(502).json({ error: 'tx failed', nonce: sent.nonce });
    }
    record.choice = landedChoice;
  }
  record.onChain = true;

  const stat = sent.landed ? { ms, block: sent.block } : {};
  broadcastToProjector('guess', { clueId: clue.clueId, who: player.name, ...stat });
  res.json({ ok: true, nonce: sent.nonce, ...stat });
});

// --- Settlement and reveal ---

const SETTLE_GRACE_MS = 2000;
const SETTLE_CHUNK = 20;

const earned = new Map<string, bigint>(); // tonight's winnings per address, from Paid events
let beatCount = 0;
let carried: SettleItem[] = [];

interface SettleOutcome {
  payments: Payment[];
  masks: Map<string, number>;
  failed: SettleItem[];
}

// One transaction per chunk. A chunk that will not go through is retried clue by
// clue, so one bad item cannot hold back everyone else's payout.
async function settleOnChain(items: SettleItem[]): Promise<SettleOutcome> {
  const out: SettleOutcome = { payments: [], masks: new Map(), failed: [] };

  const attempt = async (chunk: SettleItem[]): Promise<boolean> => {
    const hash = await sendSettle(chunk);
    const receipt = hash ? await waitLanded(hash) : null;
    if (receipt?.status !== 'success') {
      if (operatorWallet) resetNonce(operatorWallet.account.address);
      return false;
    }
    for (const log of parseEventLogs({ abi, logs: receipt.logs, eventName: ['Settled', 'Paid'] })) {
      if (log.eventName === 'Settled') {
        out.masks.set(log.args.clueId, log.args.botsRightMask);
      } else {
        const { clueId: paidFor, from, to, amount, reason } = log.args;
        out.payments.push({ clueId: paidFor, from, to, amount, reason });
      }
    }
    console.log(`[settle] ${chunk.length} clues settled in block ${receipt.blockNumber}`);
    return true;
  };

  for (let i = 0; i < items.length; i += SETTLE_CHUNK) {
    const chunk = items.slice(i, i + SETTLE_CHUNK);
    if (await attempt(chunk)) continue;
    if (chunk.length === 1) {
      out.failed.push(chunk[0]);
      continue;
    }
    for (const item of chunk) {
      if (!(await attempt([item]))) out.failed.push(item);
    }
  }
  return out;
}

async function botPools(): Promise<number[] | null> {
  try {
    return await Promise.all(
      BOTS.map(async (b) => Number(formatEther(b.address ? await getGameBalance(b.address) : 0n))),
    );
  } catch {
    return null;
  }
}

async function settleRound(): Promise<void> {
  const round = game.round;
  const clues = [...game.clues];
  const guesses = humanGuesses;
  const answers = botAnswers;
  // Guesses already on the wire get a moment to land. A bot still thinking is simply wrong.
  await Promise.race([Promise.allSettled([...inflight]), sleep(SETTLE_GRACE_MS)]);

  let payments: Payment[] = [];
  let masks = new Map<string, number>();
  let pools: { name: string; from: number; to: number }[] | undefined;
  if (chainEnabled) {
    const items = [...carried, ...buildSettlement(clues, guesses, BOT_ADDRESSES)];
    if (items.length) {
      const before = await botPools();
      const done = await settleOnChain(items);
      payments = done.payments;
      masks = done.masks;
      // A failed settle is retried with the next round, once.
      const retried = carried;
      carried = done.failed.filter((item) => !retried.includes(item));
      if (done.failed.length) console.error(`[settle] ${done.failed.length} clues failed, ${carried.length} carried over`);
      const after = await botPools();
      if (before && after) pools = BOTS.map((b, i) => ({ name: b.name, from: before[i], to: after[i] }));
    }
  }
  for (const p of payments) earned.set(p.to, (earned.get(p.to) ?? 0n) + p.amount);

  const list = outcomes(clues, guesses, answers, BOT_NAMES, masks);
  beatCount += list.filter(beatTheBots).length;
  const nameOf = (address: string) => game.players.get(address)?.name;
  broadcastToProjector('reveal', {
    round,
    cards: pickCards(list, nameOf),
    leaderboard: leaderboard(earned, nameOf),
    beatCount,
    ...(pools ? { bots: pools } : {}),
  });

  if (!chainEnabled) return;
  for (const [address, player] of game.players) {
    if (!player.ws) continue;
    sendToPlayer(player.ws, 'result', {
      payouts: payoutLines(payments, address, botName),
      balance: formatEther((heldBefore.get(address) ?? 0n) + (earned.get(address) ?? 0n)),
    });
  }
}

// --- Game event handlers ---

game.on('phase', (data) => {
  broadcastToAll('phase', data);

  if (data.name === 'WRITE') {
    humanGuesses = new Map();
    botAnswers = new Map();
    const addresses = [...game.players.keys()];
    const deals = dealRound(addresses, game.round);
    currentDeals.clear();
    for (const d of deals) {
      currentDeals.set(d.address, d);
    }

    for (const [addr, player] of game.players) {
      const deal = currentDeals.get(addr);
      if (deal && player.ws) {
        sendToPlayer(player.ws, 'deal', {
          round: game.round,
          group: deal.group,
          options: deal.options,
          mine: deal.myIndex,
          commit: deal.commit,
        });
      }
    }
  }
});

game.on('slot', async (slotData: SlotData) => {
  const base = { round: game.round, slot: slotData.index, slots: game.slots.length, endsAt: slotData.endsAt };
  broadcastToProjector('slot', {
    ...base,
    clues: slotData.clues.map((c) => ({ clueId: c.clueId, text: c.text, options: c.options })),
  });

  // Each phone gets one clue: never its own, never from its word group.
  // Rotating by join order spreads guessers evenly across the slot's clues.
  let i = 0;
  for (const [addr, player] of game.players) {
    const idx = i++;
    if (!player.ws) continue;
    const group = currentDeals.get(addr)?.group;
    const eligible = slotData.clues.filter((c) => c.giver !== addr && c.group !== group);
    const pick = eligible.length ? eligible[(idx + slotData.index) % eligible.length] : null;
    sendToPlayer(player.ws, 'slot', pick ? { ...base, clueId: pick.clueId, text: pick.text, options: pick.options } : base);
  }

  // Report each bot the moment it finishes so the room sees Chhota beat Bada to the buzzer.
  // A bot that throws counts as no answer (wrong), never a crash.
  const started = Date.now();
  const answers = botAnswers;
  const inSlot = new Set(slotData.clues.map((c) => c.clueId));
  await Promise.all(
    (['chhota', 'bada'] as const).map(async (which) => {
      const name = which === 'chhota' ? config.botChhota.name : config.botBada.name;
      let r: BotResult;
      try {
        r = await track(runBot(which, slotData));
      } catch (e: any) {
        console.error(`[bot:${name}] failed: ${e?.message ?? e}`);
        r = { name, answers: [], thinkMs: Date.now() - started };
      }
      for (const a of r.answers) {
        if (!inSlot.has(a.id) || !Number.isInteger(a.choice) || a.choice < 0 || a.choice > 3) continue;
        let forClue = answers.get(a.id);
        if (!forClue) answers.set(a.id, (forClue = new Map()));
        if (!forClue.has(name)) forClue.set(name, a.choice);
      }
      broadcastToProjector('bot', { name: r.name, thinkMs: r.thinkMs, answeredCount: r.answers.length });
    }),
  );
});

game.on('settle-needed', () => {
  console.log(`[game] Round ${game.round} settle needed — ${game.clues.length} clues`);
  settleRound().catch((e) => console.error('[settle] failed:', e));
});

game.on('round-end', (round: number) => {
  console.log(`[game] Round ${round} complete`);
});

// --- Web app ---

// One process serves the built phone and projector pages, so a single public URL is enough.
const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
app.use(express.static(webDist));
app.get('/screen', (_req, res) => res.sendFile(resolve(webDist, 'index.html')));

// --- Start ---

server.listen(config.port, () => {
  console.log(`[server] Bot ko Harao running on port ${config.port}`);
  console.log(`[server] Phase: ${game.phase}, Players: ${game.playerCount}`);
  console.log(chainEnabled ? `[server] On chain: contract ${contract}` : '[server] Off chain: CONTRACT_ADDRESS is not set');
  for (const bot of [config.botChhota, config.botBada]) {
    if (!bot.apiKey) console.log(`[server] ${bot.name} has no API key and will give no answer`);
  }
  if (config.demoMode) console.log(`[server] DEMO MODE — shorter timers`);
});
