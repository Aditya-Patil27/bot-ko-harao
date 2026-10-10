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
}

export interface SlotData {
  index: number;
  clues: ClueEntry[];
  endsAt: number;
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

  startRound(): void {
    if (this.phase !== 'LOBBY') return;
    if (this.playerCount < 3) return;
    this.round++;
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
    const clues = [...this.clues];
    const slotCount = Math.min(config.slots, clues.length);
    if (slotCount === 0) {
      this.setPhase('LOBBY', 0);
      return;
    }
    const perSlot = Math.ceil(clues.length / slotCount);
    this.slots = [];
    for (let i = 0; i < slotCount; i++) {
      this.slots.push({
        index: i,
        clues: clues.splice(0, perSlot),
        endsAt: 0,
      });
    }
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
