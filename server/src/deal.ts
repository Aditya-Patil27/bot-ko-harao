import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { keccak256, encodePacked, encodeAbiParameters, toHex, type Hex } from 'viem';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WordGroup {
  theme: string;
  items: string[];
}

// Four distinct, non-blank items. Unfilled venue placeholders ("___") fail this.
export function isPlayable(group: WordGroup): boolean {
  const items = Array.isArray(group?.items) ? group.items : [];
  if (items.length !== 4) return false;
  if (!items.every((s) => typeof s === 'string' && /[a-z0-9]/i.test(s))) return false;
  return new Set(items.map((s) => s.trim().toLowerCase())).size === 4;
}

let wordPack: WordGroup[] = [];
try {
  const raw = readFileSync(resolve(__dirname, '../../data/wordpack.json'), 'utf-8');
  const parsed = JSON.parse(raw);
  // Pack is `{ _meta, groups: [...] }`; accept a bare array too.
  const all: WordGroup[] = Array.isArray(parsed) ? parsed : (parsed.groups ?? []);
  wordPack = all.filter(isPlayable);
  if (wordPack.length < all.length) {
    console.warn(`[deal] skipping ${all.length - wordPack.length} unplayable word groups (blank or duplicate items)`);
  }
} catch {
  console.warn('[deal] wordpack.json not found, using empty');
}

let groupCursor = 0;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface Deal {
  address: string;
  group: number;
  options: string[];
  myIndex: number;
  myWord: string;
  answer: number;
  salt: Hex;
  commit: Hex;
}

export function dealRound(
  addresses: string[],
  round: number
): Deal[] {
  const deals: Deal[] = [];
  const shuffledAddrs = shuffle(addresses);

  for (const addr of shuffledAddrs) {
    const gIdx = groupCursor % wordPack.length;
    groupCursor++;
    const group = wordPack[gIdx];
    if (!group) continue;

    const items = shuffle(group.items);
    const myIndex = Math.floor(Math.random() * items.length);
    const answer = myIndex;

    const salt = toHex(
      crypto.getRandomValues(new Uint8Array(32))
    ) as Hex;

    const commit = keccak256(
      encodeAbiParameters(
        [
          { type: 'address' },
          { type: 'uint32' },
          { type: 'uint8' },
          { type: 'bytes32' },
        ],
        [addr as `0x${string}`, round, answer, salt]
      )
    );

    deals.push({
      address: addr,
      group: gIdx,
      options: items,
      myIndex,
      myWord: items[myIndex],
      answer,
      salt,
      commit,
    });
  }

  return deals;
}

export function clueId(giver: string, round: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint32' }],
      [giver as `0x${string}`, round]
    )
  );
}

const MAX_ROUND_SKIP = 100;

// The round counter starts over with the server; burners and their clues do not.
// The contract takes one clue per (giver, round), so a round number is usable only
// if none of these givers already has a clue under it.
export async function nextFreeRound(
  from: number,
  givers: string[],
  taken: (id: Hex) => Promise<boolean>
): Promise<number> {
  let round = from;
  for (let skipped = 0; skipped < MAX_ROUND_SKIP; skipped++, round++) {
    const used = await Promise.all(givers.map((g) => taken(clueId(g, round))));
    if (!used.includes(true)) break;
  }
  return round;
}
