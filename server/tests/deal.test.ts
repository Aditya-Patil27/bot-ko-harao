import { describe, expect, it } from 'vitest';
import { clueId, dealRound, isPlayable, nextFreeRound } from '../src/deal.js';

describe('isPlayable', () => {
  it('accepts four distinct items', () => {
    expect(isPlayable({ theme: 't', items: ['poha', 'misal', 'vada pav', 'sabudana khichdi'] })).toBe(true);
  });

  it('rejects unfilled venue placeholders', () => {
    expect(isPlayable({ theme: 'VENUE', items: ['___', '___', '___', '___'] })).toBe(false);
  });

  it('rejects duplicates, wrong counts and blanks', () => {
    expect(isPlayable({ theme: 't', items: ['CID', 'cid', 'Bigg Boss', 'Taarak Mehta'] })).toBe(false);
    expect(isPlayable({ theme: 't', items: ['a', 'b', 'c'] })).toBe(false);
    expect(isPlayable({ theme: 't', items: ['a', 'b', 'c', ' '] })).toBe(false);
  });
});

describe('nextFreeRound', () => {
  const a = `0x${'a1'.repeat(20)}`;
  const b = `0x${'b2'.repeat(20)}`;
  // A stand-in for the contract: which (giver, round) slots already hold a clue.
  const chain = (used: [string, number][]) => {
    const ids = new Set<string>(used.map(([giver, round]) => clueId(giver, round)));
    return async (id: string) => ids.has(id);
  };

  it('keeps the next round when nobody has a clue under it', async () => {
    expect(await nextFreeRound(1, [a, b], chain([]))).toBe(1);
    expect(await nextFreeRound(4, [a, b], chain([[a, 1], [a, 2], [b, 3]]))).toBe(4);
  });

  it('skips every round number a returning burner already used', async () => {
    expect(await nextFreeRound(1, [a, b], chain([[a, 1], [a, 2], [b, 3]]))).toBe(4);
    expect(await nextFreeRound(1, [a], chain([[a, 1], [a, 3]]))).toBe(2);
  });

  it('ignores clues from burners that are not in the room', async () => {
    expect(await nextFreeRound(1, [a], chain([[b, 1]]))).toBe(1);
  });

  it('stops skipping after a bounded number of rounds', async () => {
    expect(await nextFreeRound(1, [a], async () => true)).toBe(101);
  });
});

describe('dealRound', () => {
  it('never deals a blank or duplicate card, even past the pack size', () => {
    const addrs = Array.from({ length: 80 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    const deals = dealRound(addrs, 1);
    expect(deals).toHaveLength(80);
    for (const d of deals) {
      expect(new Set(d.options).size).toBe(4);
      expect(d.myWord).toMatch(/[a-z0-9]/i);
    }
  });
});
