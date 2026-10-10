import { describe, expect, it } from 'vitest';
import { moderateClue } from '../src/moderate.js';

const OPTS = ['Picture abhi baaki hai', 'Rahul naam toh suna hoga', 'Kitne aadmi the', 'Lion'];

describe('moderateClue', () => {
  it('accepts a clean clue', () => {
    expect(moderateClue('grandma keeps it in a jar', OPTS).ok).toBe(true);
  });

  it('rejects a multi-word option typed with spaces', () => {
    expect(moderateClue('my Picture abhi baaki hai please', OPTS)).toEqual({
      ok: false,
      reason: 'contains option "Picture abhi baaki hai"',
    });
  });

  it('rejects a multi-word option with odd spacing or punctuation', () => {
    expect(moderateClue('kitne-aadmi   THE!', OPTS).ok).toBe(false);
    expect(moderateClue('pictureabhibaakihai', OPTS).ok).toBe(false);
  });

  it('rejects a single-word option, including plurals', () => {
    expect(moderateClue('two lions', OPTS).ok).toBe(false);
  });

  it('enforces length and word limits', () => {
    expect(moderateClue('', OPTS).reason).toBe('empty');
    expect(moderateClue('a'.repeat(41), OPTS).ok).toBe(false);
    expect(moderateClue('one two three four five six seven', OPTS).ok).toBe(false);
  });
});
