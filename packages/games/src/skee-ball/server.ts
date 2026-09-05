import type { GameContext, GameInstance, GameResults, GameServerDefinition } from '@funfair/shared';
import { LockstepSim } from '../lockstep/server';
import { skeeBallMeta } from './meta';
import {
  BALLS_PER_PLAYER,
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  ROUND_MS,
  ballsLeft,
  createTable,
  isSkeeBallInput,
  msToTick,
  tableBusy,
  tableRules,
  type FeedEntry,
  type Phase,
  type RacerState,
  type SkeeBallHostState,
  type SkeeBallInput,
  type SkeeBallPlayerState,
  type TableEvent,
  type TableState,
} from './logic';

const FEED_LENGTH = 8;
export const MAX_REWIND_TICKS = 36;

type RacerSim = LockstepSim<TableState, SkeeBallInput, TableEvent>;

export class SkeeBallGame implements GameInstance<SkeeBallHostState, SkeeBallPlayerState, SkeeBallInput> {
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
      this.racers.set(p.id, { playerId: p.id, score: 0, ballsLeft: BALLS_PER_PLAYER, landings: [], lastScore: null, rank: 1 });
      this.sims.set(p.id, new LockstepSim(tableRules, createTable(), MAX_REWIND_TICKS));
    }
    this.updateRanks();
  }

  onInput(playerId: string, input: SkeeBallInput): void {
    if (this.phase !== 'playing') return;
    if (!isSkeeBallInput(input)) return;
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
          const timeUp = this.raceMs >= ROUND_MS;
          const allDone = [...this.sims.values()].every((s) => ballsLeft(s.state) === 0 && !tableBusy(s.state));
          if (timeUp || allDone) {
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
    racer.ballsLeft = ballsLeft(sim.state);
    racer.landings.push({ x: ev.x, u: ev.type === 'score' ? (ev.u ?? 0) : -1, points });
    racer.lastScore = { points, at: this.raceMs };
    this.feed.unshift({ playerId: racer.playerId, seq: ++this.seq, points, at: this.raceMs });
    if (this.feed.length > FEED_LENGTH) this.feed.length = FEED_LENGTH;
  }

  hostState(): SkeeBallHostState {
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

  playerState(playerId: string): SkeeBallPlayerState {
    const me = this.racers.get(playerId) ?? { playerId, score: 0, ballsLeft: 0, landings: [], lastScore: null, rank: 0 };
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

export const skeeBallServer: GameServerDefinition<SkeeBallHostState, SkeeBallPlayerState, SkeeBallInput> = {
  meta: skeeBallMeta,
  create: (ctx) => new SkeeBallGame(ctx),
};
