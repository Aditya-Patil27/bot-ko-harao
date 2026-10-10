import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let banned: Set<string>;
try {
  const txt = readFileSync(resolve(__dirname, '../../data/banned-words.txt'), 'utf-8');
  banned = new Set(
    txt
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim().toLowerCase())
      .filter(Boolean)
  );
} catch {
  banned = new Set();
}

export interface ModResult {
  ok: boolean;
  reason?: string;
}

export function moderateClue(text: string, options: string[]): ModResult {
  if (!text || text.trim().length === 0) return { ok: false, reason: 'empty' };
  if (text.length > 40) return { ok: false, reason: 'too long (max 40 chars)' };

  const words = text.trim().split(/\s+/);
  if (words.length > 6) return { ok: false, reason: 'too many words (max 6)' };

  // Compare as space-separated tokens so multi-word options ("Picture abhi baaki hai")
  // match normal spaced text, and also squashed so "pictureabhibaakihai" can't dodge it.
  const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const spaced = tokens(text);
  const squashed = spaced.replace(/ /g, '');
  for (const opt of options) {
    const o = tokens(opt);
    if (!o) continue;
    const multi = o.includes(' ');
    if (spaced.includes(o) || (multi && squashed.includes(o.replace(/ /g, '')))) {
      return { ok: false, reason: `contains option "${opt}"` };
    }
  }

  for (const w of words) {
    if (banned.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      return { ok: false, reason: 'banned word' };
    }
  }

  return { ok: true };
}
