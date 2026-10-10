import express from 'express';
import { createServer } from 'http';
import { getAddress, isAddress } from 'viem';
import { config } from './config.js';
import { game, type SlotData } from './game.js';
import { dealRound, clueId } from './deal.js';
import { moderateClue } from './moderate.js';
import { runBot, type BotResult } from './bots.js';
import { initWs, onIdentify, broadcastToAll, broadcastToProjector, sendToPlayer } from './ws.js';

const app = express();
app.use(express.json({ limit: '4kb' }));

const server = createServer(app);
initWs(server);

let currentDeals = new Map<string, ReturnType<typeof dealRound>[0]>();
const humanGuesses = new Map<string, Map<string, number>>(); // round key → (clueId → choice)

function guessKey(playerId: string, round: number) {
  return `${playerId}:${round}`;
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

// --- HTTP routes ---

function playerNames() {
  return [...game.players.values()].map((p) => p.name);
}

app.post('/join', (req, res) => {
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
  if (existing) return res.status(409).json({ error: 'already joined', playerId: address, name: existing.name });

  const ok = game.addPlayer({ id: address, name, address, ws: null });
  if (!ok) return res.status(409).json({ error: 'room is full' });

  broadcastToProjector('players', { count: game.playerCount, names: playerNames() });

  res.json({
    playerId: address,
    config: {
      writeS: config.writeS,
      slotS: config.slotS,
      slots: config.slots,
    },
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

app.post('/start', (_req, res) => {
  game.startRound();
  res.json({ ok: true, round: game.round });
});

app.post('/clue/submit', (req, res) => {
  const { playerId, text } = req.body;
  if (!playerId || !text) return res.status(400).json({ error: 'playerId and text required' });
  if (game.phase !== 'WRITE') return res.status(400).json({ error: 'not in write phase' });

  const deal = currentDeals.get(playerId);
  if (!deal) return res.status(400).json({ error: 'no deal for this player' });

  const mod = moderateClue(text, deal.options);
  if (!mod.ok) return res.status(400).json({ error: mod.reason });

  const entry = {
    clueId: clueId(playerId, game.round),
    giver: playerId,
    round: game.round,
    group: deal.group,
    text,
    answer: deal.myIndex,
    salt: deal.salt,
    commit: deal.commit,
    options: deal.options,
  };

  game.addClue(entry);
  broadcastToProjector('clue', { count: game.clues.length, who: game.players.get(playerId)?.name });
  res.json({ ok: true, clueId: entry.clueId });
});

app.post('/guess', (req, res) => {
  const { playerId, clueId: cid, choice } = req.body;
  if (!playerId || !cid || choice === undefined)
    return res.status(400).json({ error: 'playerId, clueId, choice required' });
  if (game.phase !== 'GUESS')
    return res.status(400).json({ error: 'not in guess phase' });
  if (!Number.isInteger(choice) || choice < 0 || choice > 3)
    return res.status(400).json({ error: 'invalid choice' });
  const player = game.players.get(playerId);
  if (!player) return res.status(400).json({ error: 'unknown player' });
  if (typeof cid !== 'string' || !game.clues.some((c) => c.clueId === cid))
    return res.status(400).json({ error: 'unknown clue' });

  const key = guessKey(playerId, game.round);
  if (!humanGuesses.has(key)) humanGuesses.set(key, new Map());
  const mine = humanGuesses.get(key)!;
  if (mine.has(cid)) return res.status(409).json({ error: 'already guessed' });
  mine.set(cid, choice);

  broadcastToProjector('guess', { clueId: cid, who: player.name });
  res.json({ ok: true });
});

// --- Game event handlers ---

game.on('phase', (data) => {
  broadcastToAll('phase', data);

  if (data.name === 'WRITE') {
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
  await Promise.all(
    (['chhota', 'bada'] as const).map(async (which) => {
      const name = which === 'chhota' ? config.botChhota.name : config.botBada.name;
      let r: BotResult;
      try {
        r = await runBot(which, slotData);
      } catch (e: any) {
        console.error(`[bot:${name}] failed: ${e?.message ?? e}`);
        r = { name, answers: [], thinkMs: Date.now() - started };
      }
      broadcastToProjector('bot', { name: r.name, thinkMs: r.thinkMs, answeredCount: r.answers.length });
    }),
  );
});

game.on('settle-needed', () => {
  console.log(`[game] Round ${game.round} settle needed — ${game.clues.length} clues`);
});

game.on('round-end', (round: number) => {
  console.log(`[game] Round ${round} complete`);
});

// --- Start ---

server.listen(config.port, () => {
  console.log(`[server] Bot ko Harao running on port ${config.port}`);
  console.log(`[server] Phase: ${game.phase}, Players: ${game.playerCount}`);
  if (config.demoMode) console.log(`[server] DEMO MODE — shorter timers`);
});
