import { describe, expect, it } from 'vitest';
import type { ClueEntry } from '../src/game.js';
import {
  beatTheBots,
  buildSettlement,
  leaderboard,
  outcomes,
  payoutLines,
  pickCards,
  type GuessBook,
  type Payment,
} from '../src/settle.js';

const addr = (tail: string) => `0x${tail.padStart(40, '0')}`;
const GIVER = addr('91');
const BOT_A = addr('b1');
const BOT_B = addr('b2');
const BOTS = [BOT_A, BOT_B];
const BOT_NAMES = ['Chhota', 'Bada'];

function clue(n: number, over: Partial<ClueEntry> = {}): ClueEntry {
  return {
    clueId: `0x${String(n).padStart(64, '0')}`,
    giver: GIVER,
    round: 1,
    group: 0,
    text: `clue ${n}`,
    answer: 1,
    salt: `0x${'11'.repeat(32)}`,
    commit: `0x${'22'.repeat(32)}`,
    options: ['poha', 'misal', 'vada pav', 'bhel'],
    onChain: true,
    ...over,
  };
}

function book(c: ClueEntry, guesses: [string, number, boolean][]): GuessBook {
  return new Map([[c.clueId, new Map(guesses.map(([player, choice, onChain]) => [player, { choice, onChain }]))]]);
}

describe('buildSettlement', () => {
  it('lists only correct on-chain guessers, in ascending address order', () => {
    // Mixed case: a plain string sort would put "0xB…" before "0xa…".
    const low = `0xa${'0'.repeat(39)}`;
    const high = `0xB${'0'.repeat(39)}`;
    const c = clue(1);
    const guesses = book(c, [
      [high, 1, true],
      [low, 1, true],
      [addr('c3'), 2, true], // wrong
      [addr('c4'), 1, false], // right, but the guess never landed
      [GIVER, 1, true],
      [BOT_A.toUpperCase().replace('0X', '0x'), 1, true],
    ]);
    expect(buildSettlement([c], guesses, BOTS)).toEqual([
      { clueId: c.clueId, answer: 1, salt: c.salt, winners: [low, high] },
    ]);
  });

  it('leaves out clues that are not on chain and keeps ones nobody got', () => {
    const offChain = clue(1, { onChain: false });
    const nobody = clue(2);
    const items = buildSettlement([offChain, nobody], book(offChain, [[addr('c1'), 1, true]]), BOTS);
    expect(items).toEqual([{ clueId: nobody.clueId, answer: 1, salt: nobody.salt, winners: [] }]);
  });
});

describe('outcomes', () => {
  const c = clue(1);
  const guesses = book(c, [
    [addr('c1'), 1, true],
    [addr('c2'), 1, false],
    [addr('c3'), 0, true],
  ]);
  const botAnswers = new Map([[c.clueId, new Map([['Chhota', 1], ['Bada', 3]])]]);

  it('counts every human guess and falls back to the bots own answers', () => {
    expect(outcomes([c], guesses, botAnswers, BOT_NAMES)).toEqual([
      { clueId: c.clueId, text: 'clue 1', answer: 'misal', giver: GIVER, humansRight: 2, humansTotal: 3, botsRight: ['Chhota'] },
    ]);
  });

  it('trusts the contract mask over what a bot said', () => {
    const [o] = outcomes([c], guesses, botAnswers, BOT_NAMES, new Map([[c.clueId, 0b10]]));
    expect(o.botsRight).toEqual(['Bada']);
    const [none] = outcomes([c], guesses, botAnswers, BOT_NAMES, new Map([[c.clueId, 0]]));
    expect(beatTheBots(none)).toBe(true);
  });
});

describe('pickCards', () => {
  const base = { giver: GIVER, answer: 'misal' };
  const nameOf = (a: string) => (a === GIVER ? 'Priya' : undefined);

  it('picks one clue of each kind and names only the winning writer', () => {
    const cards = pickCards(
      [
        { ...base, clueId: '1', text: 'small win', humansRight: 1, humansTotal: 4, botsRight: [] },
        { ...base, clueId: '2', text: 'big win', humansRight: 3, humansTotal: 4, botsRight: [] },
        { ...base, clueId: '3', text: 'too niche', humansRight: 0, humansTotal: 5, botsRight: ['Bada'] },
        { ...base, clueId: '4', text: 'too easy', humansRight: 4, humansTotal: 4, botsRight: ['Chhota', 'Bada'] },
      ],
      nameOf,
    );
    expect(cards.map((c) => [c.kind, c.text, c.giver])).toEqual([
      ['beat', 'big win', 'Priya'],
      ['niche', 'too niche', undefined],
      ['obvious', 'too easy', undefined],
    ]);
  });

  it('leaves out a kind with no example', () => {
    const cards = pickCards([{ ...base, clueId: '1', text: 'unseen', humansRight: 0, humansTotal: 0, botsRight: [] }], nameOf);
    expect(cards).toEqual([]);
  });
});

describe('payouts', () => {
  const me = addr('c1');
  const R = 5_000_000_000_000_000n;
  const G = 10_000_000_000_000_000n;
  const payments: Payment[] = [
    { clueId: '1', from: BOT_A, to: me, amount: R, reason: 1 },
    { clueId: '2', from: BOT_A, to: me.toUpperCase().replace('0X', '0x'), amount: R, reason: 1 },
    { clueId: '3', from: BOT_B, to: me, amount: G, reason: 2 },
    { clueId: '3', from: BOT_B, to: addr('c2'), amount: R, reason: 1 },
  ];
  const botName = (a: string) => BOT_NAMES[BOTS.indexOf(a)];

  it('adds up one line per bot and reason for a player', () => {
    expect(payoutLines(payments, me, botName)).toEqual([
      { label: 'Beat Chhota ×2', amount: '0.01' },
      { label: 'Your clue fooled Bada', amount: '0.01' },
    ]);
    expect(payoutLines(payments, addr('c9'), botName)).toEqual([]);
  });

  it('ranks the leaderboard by winnings and drops zeroes', () => {
    const earned = new Map([
      [addr('c1'), R],
      [addr('c2'), G],
      [addr('c3'), 0n],
    ]);
    const nameOf = (a: string) => (a === addr('c1') ? 'Asha' : undefined);
    expect(leaderboard(earned, nameOf)).toEqual([
      { name: '0x0000…', earned: '0.01' },
      { name: 'Asha', earned: '0.005' },
    ]);
  });
});
