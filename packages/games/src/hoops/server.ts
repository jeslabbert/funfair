import type { GameContext, GameInstance, GameResults, GameServerDefinition } from '@funfair/shared';
import { LockstepSim } from '../lockstep/server';
import { hoopsMeta } from './meta';
import {
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  ROUND_MS,
  createTable,
  isHoopsInput,
  msToTick,
  tableRules,
  type FeedEntry,
  type Phase,
  type RacerState,
  type HoopsHostState,
  type HoopsInput,
  type HoopsPlayerState,
  type TableEvent,
  type TableState,
} from './logic';

const FEED_LENGTH = 8;
export const MAX_REWIND_TICKS = 36;

type RacerSim = LockstepSim<TableState, HoopsInput, TableEvent>;

export class HoopsGame implements GameInstance<HoopsHostState, HoopsPlayerState, HoopsInput> {
  private phase: Phase = 'countdown';
  private countdownMs = COUNTDOWN_MS;
  private raceMs = 0;
  private lingerMs = FINISH_LINGER_MS;
  private done = false;
  private winnerId: string | null = null;
  private readonly racers = new Map<string, RacerState>();
  private readonly sims = new Map<string, RacerSim>();
  private readonly feed: FeedEntry[] = [];
  private seq = 0;

  constructor(ctx: GameContext) {
    for (const p of ctx.players) {
      this.racers.set(p.id, { playerId: p.id, score: 0, attempts: 0, makes: 0, streak: 0, bestStreak: 0, shots: [], lastScore: null, rank: 1 });
      this.sims.set(p.id, new LockstepSim(tableRules, createTable(), MAX_REWIND_TICKS));
    }
    this.updateRanks();
  }

  onInput(playerId: string, input: HoopsInput): void {
    if (this.phase !== 'playing') return;
    if (!isHoopsInput(input)) return;
    const racer = this.racers.get(playerId);
    const sim = this.sims.get(playerId);
    if (!racer || !sim) return;
    sim.input(input, (ev) => this.onEvent(racer, sim, ev));
  }

  tick(dtMs: number): void {
    switch (this.phase) {
      case 'countdown':
        this.countdownMs -= dtMs;
        if (this.countdownMs <= 0) {
          this.countdownMs = 0;
          this.phase = 'playing';
        }
        break;
      case 'playing':
      case 'finished': {
        this.raceMs += dtMs;
        const target = msToTick(this.raceMs);
        let changed = false;
        for (const racer of this.racers.values()) {
          const sim = this.sims.get(racer.playerId)!;
          const before = racer.score;
          sim.advanceTo(target, (ev) => this.onEvent(racer, sim, ev));
          if (racer.score !== before) changed = true;
        }
        if (changed) this.updateRanks();
        if (this.phase === 'playing') {
          if (this.raceMs >= ROUND_MS) {
            this.phase = 'finished';
            this.updateRanks();
            this.winnerId = this.orderedRacers()[0]?.playerId ?? null;
          }
        } else {
          this.lingerMs -= dtMs;
          if (this.lingerMs <= 0) this.done = true;
        }
        break;
      }
    }
  }

  private onEvent(racer: RacerState, sim: RacerSim, ev: TableEvent): void {
    if (ev.type !== 'score' && ev.type !== 'miss') return;
    sim.barrier(ev.tick);
    const points = ev.type === 'score' ? ev.points! : 0;
    racer.score += points;
    racer.attempts += 1;
    if (points > 0) {
      racer.makes += 1;
      racer.streak += 1;
      racer.bestStreak = Math.max(racer.bestStreak, racer.streak);
    } else racer.streak = 0;
    racer.shots.push({ x: ev.x, y: ev.y, points });
    racer.lastScore = { points, at: this.raceMs };
    this.feed.unshift({ playerId: racer.playerId, seq: ++this.seq, points, swish: !!ev.swish, at: this.raceMs });
    if (this.feed.length > FEED_LENGTH) this.feed.length = FEED_LENGTH;
  }

  hostState(): HoopsHostState {
    return {
      phase: this.phase,
      countdownMs: this.countdownMs,
      raceMs: this.raceMs,
      roundMsLeft: Math.max(0, ROUND_MS - this.raceMs),
      racers: this.orderedRacers(),
      feed: [...this.feed],
      winnerId: this.winnerId,
    };
  }

  playerState(playerId: string): HoopsPlayerState {
    const me = this.racers.get(playerId) ?? { playerId, score: 0, attempts: 0, makes: 0, streak: 0, bestStreak: 0, shots: [], lastScore: null, rank: 0 };
    const table = this.sims.get(playerId)?.state ?? createTable();
    let leaderScore = 0;
    for (const r of this.racers.values()) leaderScore = Math.max(leaderScore, r.score);
    return {
      phase: this.phase,
      countdownMs: this.countdownMs,
      raceMs: this.raceMs,
      roundMsLeft: Math.max(0, ROUND_MS - this.raceMs),
      me,
      table,
      leaderScore,
      playerCount: this.racers.size,
      winnerId: this.winnerId,
    };
  }

  isFinished(): boolean {
    return this.done;
  }

  results(): GameResults {
    return {
      standings: this.orderedRacers().map((r) => ({ playerId: r.playerId, score: r.score, label: `${r.score} pts` })),
    };
  }

  private orderedRacers(): RacerState[] {
    return [...this.racers.values()].sort((a, b) => b.score - a.score);
  }

  private updateRanks(): void {
    const ordered = this.orderedRacers();
    let rank = 0;
    let prev: RacerState | null = null;
    ordered.forEach((r, i) => {
      if (!prev || prev.score !== r.score) rank = i + 1;
      r.rank = rank;
      prev = r;
    });
  }
}

export const hoopsServer: GameServerDefinition<HoopsHostState, HoopsPlayerState, HoopsInput> = {
  meta: hoopsMeta,
  create: (ctx) => new HoopsGame(ctx),
};
