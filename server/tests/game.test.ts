import { describe, expect, it } from 'vitest';
import { splitClues } from '../src/game.js';

describe('splitClues', () => {
  const sizes = (n: number, max: number) => splitClues(Array.from({ length: n }, (_, i) => i), max).map((s) => s.length);

  it('never leaves a slot empty', () => {
    // These counts used to end in an empty last slot with four slots.
    expect(sizes(5, 4)).toEqual([2, 1, 1, 1]);
    expect(sizes(6, 4)).toEqual([2, 2, 1, 1]);
    expect(sizes(9, 4)).toEqual([3, 2, 2, 2]);
    expect(sizes(4, 3)).toEqual([2, 1, 1]);
    for (let max = 1; max <= 6; max++) {
      for (let n = 1; n <= 80; n++) expect(Math.min(...sizes(n, max))).toBeGreaterThan(0);
    }
  });

  it('uses one slot per clue when there are fewer clues than slots', () => {
    expect(sizes(3, 4)).toEqual([1, 1, 1]);
    expect(sizes(0, 4)).toEqual([]);
  });

  it('keeps every clue once, in order, with slot sizes at most one apart', () => {
    const clues = Array.from({ length: 23 }, (_, i) => i);
    const slots = splitClues(clues, 4);
    expect(slots.flat()).toEqual(clues);
    expect(Math.max(...slots.map((s) => s.length)) - Math.min(...slots.map((s) => s.length))).toBeLessThanOrEqual(1);
  });
});
