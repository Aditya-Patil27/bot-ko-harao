import { describe, expect, it } from 'vitest';
import { dealRound, isPlayable } from '../src/deal.js';

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
