import { EventEmitter } from 'events';
import { config } from './config.js';

export type Phase = 'LOBBY' | 'WRITE' | 'GUESS' | 'REVEAL';

export interface Player {
  id: string;
  name: string;
  address: string;
  ws: any;
}

export interface ClueEntry {
  clueId: string;
  giver: string;
  round: number;
  group: number;
  text: string;
  answer: number;
  salt: string;
  commit: string;
  options: string[];
  // True once the giver's postClue transaction landed; only then can it be guessed and settled on chain.
  onChain?: boolean;
}

export interface SlotData {
  index: number;
  clues: ClueEntry[];
  endsAt: number;
}

// Spreads a round's clues over at most `max` guess slots, as evenly as it can.
// No slot is ever empty: an empty one is a blank big screen for a whole slot.
export function splitClues<T>(clues: T[], max: number): T[][] {
  const rest = [...clues];
  const count = Math.min(max, rest.length);
  const out: T[][] = [];
  for (let i = 0; i < count; i++) out.push(rest.splice(0, Math.ceil(rest.length / (count - i))));
  return out;
}

export class GameState extends EventEmitter {
  phase: Phase = 'LOBBY';
  round = 0;
  slot = 0;
  endsAt = 0;
  players = new Map<string, Player>();
  clues: ClueEntry[] = [];
  slots: SlotData[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  get playerCount() {
    return this.players.size;
  }

  addPlayer(player: Player): boolean {
    if (this.players.size >= config.maxPlayers) return false;
    if (this.players.has(player.address)) return false;
    this.players.set(player.address, player);
    this.emit('player-join', player);
    return true;
  }

  removePlayer(address: string): void {
    this.players.delete(address);
  }

  startRound(round = this.round + 1): void {
    if (this.phase !== 'LOBBY') return;
    if (this.playerCount < 3) return;
    this.round = round;
    this.clues = [];
    this.slots = [];
    this.setPhase('WRITE', config.writeS);
  }

  addClue(clue: ClueEntry): void {
    if (this.phase !== 'WRITE') return;
    this.clues.push(clue);
    this.emit('clue', clue);
  }

  private setPhase(phase: Phase, durationS: number): void {
    this.phase = phase;
    this.endsAt = Date.now() + durationS * 1000;
    this.emit('phase', { name: phase, round: this.round, endsAt: this.endsAt });

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onPhaseEnd(), durationS * 1000);
  }

  private onPhaseEnd(): void {
    switch (this.phase) {
      case 'WRITE':
        this.buildSlots();
        if (this.slots.length === 0) break; // nobody wrote a clue: buildSlots went back to LOBBY
        this.slot = 0;
        this.startNextSlot();
        break;
      case 'GUESS':
        this.slot++;
        if (this.slot < this.slots.length) {
          this.startNextSlot();
        } else {
          this.emit('settle-needed');
          this.setPhase('REVEAL', config.revealS);
        }
        break;
      case 'REVEAL':
        this.setPhase('LOBBY', 0);
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.emit('round-end', this.round);
        break;
    }
  }

  private buildSlots(): void {
    const groups = splitClues(this.clues, config.slots);
    if (groups.length === 0) {
      this.setPhase('LOBBY', 0);
      return;
    }
    this.slots = groups.map((clues, index) => ({ index, clues, endsAt: 0 }));
  }

  private startNextSlot(): void {
    const slotData = this.slots[this.slot];
    slotData.endsAt = Date.now() + config.slotS * 1000;
    this.setPhase('GUESS', config.slotS);
    this.emit('slot', slotData);
  }

  forceNextRound(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.phase = 'LOBBY';
    this.startRound();
  }
}

export const game = new GameState();
