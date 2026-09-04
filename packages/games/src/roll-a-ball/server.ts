import type { GameContext, GameInstance, GameResults, GameServerDefinition } from '@funfair/shared';
import { rollABallMeta } from './meta';
import {
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  RETURN_DELAY_MS,
  TRACK_LENGTH,
  isRollInput,
  ordinal,
  simulateRoll,
  clampLaunch,
  type FeedEntry,
  type RacePhase,
  type RacerState,
  type RollABallHostState,
  type RollABallInput,
  type RollABallPlayerState,
  type RollOutcome,
} from './logic';

const FEED_LENGTH = 8;

interface PendingBall {
  outcome: RollOutcome;
  applied: boolean;
}

export class RollABallGame implements GameInstance<RollABallHostState, RollABallPlayerState, RollABallInput> {
  private phase: RacePhase = 'countdown';
  private countdownMs = COUNTDOWN_MS;
  private raceMs = 0;
  private lingerMs = FINISH_LINGER_MS;
  private done = false;
  private winnerId: string | null = null;
  private readonly racers = new Map<string, RacerState>();
  private readonly pending = new Map<string, PendingBall>();
  private readonly feed: FeedEntry[] = [];

  constructor(ctx: GameContext) {
    for (const p of ctx.players) {
      this.racers.set(p.id, { playerId: p.id, progress: 0, rolls: 0, lastRoll: null, ball: null, finishedAt: null, rank: 1 });
    }
    this.updateRanks();
  }

  onInput(playerId: string, input: RollABallInput): void {
    if (this.phase !== 'racing') return;
    if (!isRollInput(input)) return;
    const racer = this.racers.get(playerId);
    if (!racer || racer.finishedAt !== null) return;
    if (racer.ball) return; // one ball at a time – it has to drop in or come back first

    const launch = clampLaunch(input.vx, input.vy);
    if (launch.vy <= 0) return;
    const sim = simulateRoll(launch.vx, launch.vy);
    racer.ball = { vx: launch.vx, vy: launch.vy, launchedAt: this.raceMs };
    this.pending.set(playerId, { outcome: sim.outcome, applied: false });
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
        this.raceMs += dtMs;
        this.settleBalls();
        break;
      case 'finished':
        this.raceMs += dtMs;
        this.settleBalls();
        this.lingerMs -= dtMs;
        if (this.lingerMs <= 0) this.done = true;
        break;
    }
  }

  /** Apply outcomes whose ball has just dropped in / come back, and hand out fresh balls. */
  private settleBalls(): void {
    let changed = false;
    for (const racer of this.racers.values()) {
      const ball = racer.ball;
      const pending = this.pending.get(racer.playerId);
      if (!ball || !pending) continue;
      const endsAt = ball.launchedAt + pending.outcome.endedAt;
      if (!pending.applied && this.raceMs >= endsAt) {
        pending.applied = true;
        this.applyOutcome(racer, pending.outcome);
        changed = true;
      }
      if (this.raceMs >= endsAt + RETURN_DELAY_MS) {
        racer.ball = null;
        this.pending.delete(racer.playerId);
      }
    }
    if (changed) this.updateRanks();
  }

  private applyOutcome(racer: RacerState, outcome: RollOutcome): void {
    racer.rolls += 1;
    racer.progress = Math.min(TRACK_LENGTH, racer.progress + outcome.points);
    racer.lastRoll = { ...outcome, seq: racer.rolls, at: this.raceMs };
    this.feed.unshift({ playerId: racer.playerId, seq: racer.rolls, points: outcome.points, kind: outcome.kind, zone: outcome.zone, at: this.raceMs });
    if (this.feed.length > FEED_LENGTH) this.feed.length = FEED_LENGTH;

    if (racer.progress >= TRACK_LENGTH && racer.finishedAt === null) {
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
    };
  }

  playerState(playerId: string): RollABallPlayerState {
    const me = this.racers.get(playerId) ?? { playerId, progress: 0, rolls: 0, lastRoll: null, ball: null, finishedAt: null, rank: 0 };
    const pending = this.pending.get(playerId);
    const cooldownMs = me.ball && pending ? Math.max(0, me.ball.launchedAt + pending.outcome.endedAt + RETURN_DELAY_MS - this.raceMs) : 0;
    let leaderProgress = 0;
    for (const r of this.racers.values()) leaderProgress = Math.max(leaderProgress, r.progress);
    return {
      phase: this.phase,
      countdownMs: this.countdownMs,
      raceMs: this.raceMs,
      trackLength: TRACK_LENGTH,
      me,
      cooldownMs,
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
