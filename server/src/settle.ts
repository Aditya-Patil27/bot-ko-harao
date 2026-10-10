import { formatEther, type Address, type Hex } from 'viem';
import type { ClueEntry } from './game.js';

export interface HumanGuess {
  choice: number;
  onChain: boolean;
}

// clueId → (player address → guess), for the round being played.
export type GuessBook = Map<string, Map<string, HumanGuess>>;

export interface SettleItem {
  clueId: Hex;
  answer: number;
  salt: Hex;
  winners: Address[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Only what landed on chain goes into a settlement: the contract rejects the
// whole batch if one listed winner has no matching guess. Winners must ascend.
export function buildSettlement(clues: ClueEntry[], guesses: GuessBook, bots: string[]): SettleItem[] {
  return clues
    .filter((c) => c.onChain)
    .map((c) => {
      const winners = [...(guesses.get(c.clueId) ?? [])]
        .filter(
          ([player, g]) =>
            g.onChain && g.choice === c.answer && !same(player, c.giver) && !bots.some((b) => same(b, player)),
        )
        .map(([player]) => player as Address)
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      return { clueId: c.clueId as Hex, answer: c.answer, salt: c.salt as Hex, winners };
    });
}

export interface Outcome {
  clueId: string;
  text: string;
  answer: string;
  giver: string;
  humansRight: number;
  humansTotal: number;
  botsRight: string[];
}

// botNames is in contract order (bots[0], bots[1]), matching the Settled event's
// mask. A clue the chain settled uses that mask; otherwise the bot's own answer counts.
export function outcomes(
  clues: ClueEntry[],
  guesses: GuessBook,
  botAnswers: Map<string, Map<string, number>>,
  botNames: string[],
  settledMasks = new Map<string, number>(),
): Outcome[] {
  return clues.map((c) => {
    const all = [...(guesses.get(c.clueId)?.values() ?? [])];
    const mask = settledMasks.get(c.clueId);
    return {
      clueId: c.clueId,
      text: c.text,
      answer: c.options[c.answer],
      giver: c.giver,
      humansRight: all.filter((g) => g.choice === c.answer).length,
      humansTotal: all.length,
      botsRight: botNames.filter((name, i) =>
        mask === undefined ? botAnswers.get(c.clueId)?.get(name) === c.answer : ((mask >> i) & 1) === 1,
      ),
    };
  });
}

export const beatTheBots = (o: Outcome) => o.humansRight > 0 && o.botsRight.length === 0;

export interface RevealCard {
  kind: 'beat' | 'niche' | 'obvious';
  text: string;
  answer: string;
  giver?: string;
  humansRight: number;
  humansTotal: number;
  botsRight: string[];
}

function top(pool: Outcome[], score: (o: Outcome) => number): Outcome | null {
  return pool.reduce<Outcome | null>((best, o) => (!best || score(o) > score(best) ? o : best), null);
}

// Up to three cards; a kind with no example is left out. Only the winning clue names its writer.
export function pickCards(list: Outcome[], nameOf: (address: string) => string | undefined): RevealCard[] {
  const beat = top(list.filter(beatTheBots), (o) => o.humansRight);
  const niche = top(
    list.filter((o) => o.humansRight === 0 && o.humansTotal > 0),
    (o) => o.humansTotal,
  );
  const obvious = top(
    list.filter((o) => o.botsRight.length > 0 && o !== niche),
    (o) => o.botsRight.length * 1000 + o.humansRight,
  );
  const card = (kind: RevealCard['kind'], o: Outcome): RevealCard => ({
    kind,
    text: o.text,
    answer: o.answer,
    ...(kind === 'beat' ? { giver: nameOf(o.giver) } : {}),
    humansRight: o.humansRight,
    humansTotal: o.humansTotal,
    botsRight: o.botsRight,
  });
  return [
    ...(beat ? [card('beat', beat)] : []),
    ...(niche ? [card('niche', niche)] : []),
    ...(obvious ? [card('obvious', obvious)] : []),
  ];
}

// One Paid event from the contract. reason: 1 = guesser beat the bot, 2 = giver's clue did.
export interface Payment {
  clueId: string;
  from: string;
  to: string;
  amount: bigint;
  reason: number;
}

export interface PayoutLine {
  label: string;
  amount: string;
}

// One line per bot and reason, so three beaten clues read "Beat Chhota ×3".
export function payoutLines(payments: Payment[], player: string, botName: (address: string) => string): PayoutLine[] {
  const sums = new Map<string, { count: number; total: bigint }>();
  for (const p of payments) {
    if (!same(p.to, player)) continue;
    const label = p.reason === 2 ? `Your clue fooled ${botName(p.from)}` : `Beat ${botName(p.from)}`;
    const sum = sums.get(label) ?? { count: 0, total: 0n };
    sums.set(label, { count: sum.count + 1, total: sum.total + p.amount });
  }
  return [...sums].map(([label, s]) => ({
    label: s.count > 1 ? `${label} ×${s.count}` : label,
    amount: formatEther(s.total),
  }));
}

export function leaderboard(
  earned: Map<string, bigint>,
  nameOf: (address: string) => string | undefined,
  limit = 10,
): { name: string; earned: string }[] {
  return [...earned]
    .filter(([, amount]) => amount > 0n)
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
    .slice(0, limit)
    .map(([address, amount]) => ({ name: nameOf(address) ?? `${address.slice(0, 6)}…`, earned: formatEther(amount) }));
}
