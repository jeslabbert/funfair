import type { GameContext, GameInstance, GameResults, GameServerDefinition } from '@funfair/shared';
import { rollABallMeta } from './meta';
import { LockstepSim } from '../lockstep/server';
import {
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  HOLES,
  TRACK_LENGTH,
  createTable,
  isRollInput,
  msToTick,
  ordinal,
  tableRules,
  waveAt,
  WAVE_NAMES,
  type BallView,
  type FeedEntry,
  type RacePhase,
  type RacerState,
  type RollABallHostState,
  type RollABallInput,
  type RollABallPlayerState,
  type RollKind,
  type TableEvent,
  type TableState,
  type Zone,
} from './logic';

const FEED_LENGTH = 8;
/** How far back (in ticks, 120/s) a late input may be applied: 300 ms. */
export const MAX_REWIND_TICKS = 36;

type RacerSim = LockstepSim<TableState, RollABallInput, TableEvent>;

export class RollABallGame implements GameInstance<RollABallHostState, RollABallPlayerState, RollABallInput> {
  private phase: RacePhase = 'countdown';
  private countdownMs = COUNTDOWN_MS;
  private raceMs = 0;
  private lingerMs = FINISH_LINGER_MS;
  private done = false;
  private winnerId: string | null = null;
  private readonly racers = new Map<string, RacerState>();
  private readonly sims = new Map<string, RacerSim>();
  private readonly feed: FeedEntry[] = [];
  private readonly seed: number;
  private readonly obstacles: boolean;

  constructor(ctx: GameContext) {
    this.seed = Math.floor(ctx.random() * 0x7fffffff) >>> 0;
    // The room may insist; otherwise the server flips a coin for this race.
    const wanted = ctx.options?.obstacles;
    this.obstacles = typeof wanted === 'boolean' ? wanted : ctx.random() < 0.5;
    for (const p of ctx.players) {
      const table = createTable(this.seed, this.obstacles);
      this.racers.set(p.id, { playerId: p.id, progress: 0, rolls: 0, lastRoll: null, balls: views(table), finishedAt: null, rank: 1 });
      this.sims.set(p.id, new LockstepSim(tableRules, table, MAX_REWIND_TICKS));
    }
    this.updateRanks();
  }

  onInput(playerId: string, input: RollABallInput): void {
    if (this.phase !== 'racing') return;
    if (!isRollInput(input)) return;
    const racer = this.racers.get(playerId);
    const sim = this.sims.get(playerId);
    if (!racer || !sim || racer.finishedAt !== null) return;

    sim.input(input, (ev) => this.score(racer, sim, ev));
    racer.balls = views(sim.state);
  }

  tick(dtMs: number): void {
    switch (this.phase) {
      case 'countdown':
        this.countdownMs -= dtMs;
        if (this.countdownMs <= 0) {
          this.countdownMs = 0;
          this.phase = 'racing';
        }
        break;
      case 'racing':
      case 'finished': {
        this.raceMs += dtMs;
        const target = msToTick(this.raceMs);
        let changed = false;
        for (const racer of this.racers.values()) {
          const sim = this.sims.get(racer.playerId)!;
          const before = racer.progress;
          sim.advanceTo(target, (ev) => this.score(racer, sim, ev));
          racer.balls = views(sim.state);
          if (racer.progress !== before) changed = true;
        }
        if (changed) this.updateRanks();
        if (this.phase === 'finished') {
          this.lingerMs -= dtMs;
          if (this.lingerMs <= 0) this.done = true;
        }
        break;
      }
    }
  }

  private score(racer: RacerState, sim: RacerSim, ev: TableEvent): void {
    if (racer.finishedAt !== null) return;
    let kind: RollKind;
    let points = 0;
    let zone: Zone | null = null;
    let row: number | null = null;
    let col: number | null = null;
    if (ev.type === 'hit') {
      const hole = HOLES[ev.hole!]!;
      kind = 'hit';
      points = hole.points;
      zone = hole.zone;
      row = hole.row;
      col = hole.col;
    } else if (ev.type === 'gutter') {
      kind = 'gutter';
    } else if (ev.type === 'settle' && ev.crossedLip) {
      kind = 'back';
    } else {
      return;
    }
    sim.barrier(ev.tick);
    racer.rolls += 1;
    racer.progress = Math.min(TRACK_LENGTH, racer.progress + points);
    racer.lastRoll = { kind, points, zone, row, col, seq: racer.rolls, at: this.raceMs };
    this.feed.unshift({ playerId: racer.playerId, seq: racer.rolls, points, kind, zone, at: this.raceMs });
    if (this.feed.length > FEED_LENGTH) this.feed.length = FEED_LENGTH;

    if (racer.progress >= TRACK_LENGTH) {
      racer.finishedAt = this.raceMs;
      if (this.winnerId === null) {
        this.winnerId = racer.playerId;
        this.phase = 'finished';
      }
    }
  }

  hostState(): RollABallHostState {
    return {
      phase: this.phase,
      countdownMs: this.countdownMs,
      raceMs: this.raceMs,
      trackLength: TRACK_LENGTH,
      racers: this.orderedRacers(),
      feed: [...this.feed],
      winnerId: this.winnerId,
      obstacles: this.obstacles,
      wave: this.currentWave(),
    };
  }

  private currentWave(): RollABallHostState['wave'] {
    if (!this.obstacles || this.phase === 'countdown') return null;
    const w = waveAt(msToTick(this.raceMs), this.seed);
    return w ? { kind: w.kind, name: WAVE_NAMES[w.kind], t: w.t, alpha: w.alpha } : null;
  }

  playerState(playerId: string): RollABallPlayerState {
    const me = this.racers.get(playerId) ?? { playerId, progress: 0, rolls: 0, lastRoll: null, balls: [], finishedAt: null, rank: 0 };
    const table = this.sims.get(playerId)?.state ?? createTable(this.seed, this.obstacles);
    let leaderProgress = 0;
    for (const r of this.racers.values()) leaderProgress = Math.max(leaderProgress, r.progress);
    return {
      phase: this.phase,
      countdownMs: this.countdownMs,
      raceMs: this.raceMs,
      trackLength: TRACK_LENGTH,
      me,
      table,
      leaderProgress,
      playerCount: this.racers.size,
      winnerId: this.winnerId,
    };
  }

  isFinished(): boolean {
    return this.done;
  }

  results(): GameResults {
    return {
      standings: this.orderedRacers().map((r) => ({
        playerId: r.playerId,
        score: r.progress,
        label: r.finishedAt !== null ? `${ordinal(r.rank)} · finished` : `${ordinal(r.rank)} · ${r.progress}/${TRACK_LENGTH}`,
      })),
    };
  }

  private orderedRacers(): RacerState[] {
    return [...this.racers.values()].sort(compareRacers);
  }

  private updateRanks(): void {
    const ordered = this.orderedRacers();
    let rank = 0;
    let prev: RacerState | null = null;
    ordered.forEach((r, i) => {
      // Ties share a rank while racing; finishing order breaks ties at the line.
      if (!prev || compareRacers(prev, r) !== 0) rank = i + 1;
      r.rank = rank;
      prev = r;
    });
  }
}

function views(t: TableState): BallView[] {
  return t.balls.map(({ id, x, y, status }) => ({ id, x, y, status }));
}

function compareRacers(a: RacerState, b: RacerState): number {
  if (a.finishedAt !== null || b.finishedAt !== null) {
    if (a.finishedAt === null) return 1;
    if (b.finishedAt === null) return -1;
    return a.finishedAt - b.finishedAt;
  }
  return b.progress - a.progress;
}

export const rollABallServer: GameServerDefinition<RollABallHostState, RollABallPlayerState, RollABallInput> = {
  meta: rollABallMeta,
  create: (ctx) => new RollABallGame(ctx),
};
