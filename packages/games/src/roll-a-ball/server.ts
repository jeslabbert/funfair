import type { GameContext, GameInstance, GameResults, GameServerDefinition } from '@funfair/shared';
import { rollABallMeta } from './meta';
import {
  BALL_START_XS,
  BOARD,
  CHUTE_DELAY_MS,
  CHUTE_SLOTS,
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  PHYSICS,
  TRACK_LENGTH,
  clampLaunch,
  clampLaunchPosition,
  isRollInput,
  ordinal,
  simulateRoll,
  type BallView,
  type FeedEntry,
  type RacePhase,
  type RacerState,
  type RollABallHostState,
  type RollABallInput,
  type RollABallPlayerState,
  type RollOutcome,
  type RollSimulation,
} from './logic';

const FEED_LENGTH = 8;

export class RollABallGame implements GameInstance<RollABallHostState, RollABallPlayerState, RollABallInput> {
  private phase: RacePhase = 'countdown';
  private countdownMs = COUNTDOWN_MS;
  private raceMs = 0;
  private lingerMs = FINISH_LINGER_MS;
  private done = false;
  private winnerId: string | null = null;
  private readonly racers = new Map<string, RacerState>();
  /** The simulation behind each racer's current flight. */
  private readonly pending = new Map<string, RollSimulation>();
  /** When each ball in the chute comes back, per racer. */
  private readonly returns = new Map<string, Map<number, number>>();
  private readonly feed: FeedEntry[] = [];

  constructor(ctx: GameContext) {
    for (const p of ctx.players) {
      this.racers.set(p.id, {
        playerId: p.id,
        progress: 0,
        rolls: 0,
        lastRoll: null,
        balls: BALL_START_XS.map((x, id) => ({ id, x, y: BOARD.ballStartY, status: 'resting' })),
        flight: null,
        finishedAt: null,
        rank: 1,
      });
      this.returns.set(p.id, new Map());
    }
    this.updateRanks();
  }

  onInput(playerId: string, input: RollABallInput): void {
    if (this.phase !== 'racing') return;
    if (!isRollInput(input)) return;
    const racer = this.racers.get(playerId);
    if (!racer || racer.finishedAt !== null) return;
    if (racer.flight) return; // one roll at a time – the table has to settle first
    const ball = racer.balls.find((b) => b.id === input.ball && b.status === 'resting');
    if (!ball) return;

    const pos = clampLaunchPosition(input.x, input.y);
    const vel = clampLaunch(input.vx, input.vy);
    const launch = { ball: ball.id, x: pos.x, y: pos.y, vx: vel.vx, vy: vel.vy };
    const atRest = racer.balls.filter((b) => b.status === 'resting').map(({ id, x, y }) => ({ id, x, y }));
    const sim = simulateRoll(launch, atRest);
    racer.flight = { launch, atRest, launchedAt: this.raceMs };
    ball.status = 'rolling';
    this.pending.set(playerId, sim);
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
        this.settle();
        break;
      case 'finished':
        this.raceMs += dtMs;
        this.settle();
        this.lingerMs -= dtMs;
        if (this.lingerMs <= 0) this.done = true;
        break;
    }
  }

  /** Land rolls whose balls have all settled, then bring balls back from the chute. */
  private settle(): void {
    let changed = false;
    for (const racer of this.racers.values()) {
      const flight = racer.flight;
      const sim = this.pending.get(racer.playerId);
      const returns = this.returns.get(racer.playerId)!;

      if (flight && sim && this.raceMs >= flight.launchedAt + sim.outcome.endedAt) {
        const survivors = new Map(sim.final.map((b) => [b.id, b]));
        for (const ball of racer.balls) {
          if (ball.status === 'returning') continue;
          const rest = survivors.get(ball.id);
          if (rest) {
            ball.x = rest.x;
            ball.y = rest.y;
            ball.status = 'resting';
          } else {
            ball.status = 'returning';
            returns.set(ball.id, this.raceMs + CHUTE_DELAY_MS);
          }
        }
        // Letting go of a ball on the ramp without rolling it isn't a roll.
        const wasDrop = sim.outcome.kind === 'back' && sim.outcome.peakY < BOARD.rampLength && sim.captures.length === 0;
        if (!wasDrop) {
          this.applyOutcome(racer, sim.outcome);
          changed = true;
        }
        racer.flight = null;
        this.pending.delete(racer.playerId);
      }

      if (!racer.flight) {
        for (const ball of racer.balls) {
          const at = returns.get(ball.id);
          if (ball.status !== 'returning' || at === undefined || this.raceMs < at) continue;
          const x = this.freeSlot(racer.balls);
          ball.x = x;
          ball.y = BOARD.ballStartY;
          ball.status = 'resting';
          returns.delete(ball.id);
        }
      }
    }
    if (changed) this.updateRanks();
  }

  /** First chute slot along the bumper that isn't blocked by a resting ball. */
  private freeSlot(balls: BallView[]): number {
    const gap = PHYSICS.ballRadius * 2 + 0.05;
    for (const x of CHUTE_SLOTS) {
      if (balls.every((b) => b.status !== 'resting' || Math.abs(b.x - x) >= gap)) return x;
    }
    return 0;
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
    const me = this.racers.get(playerId) ?? {
      playerId,
      progress: 0,
      rolls: 0,
      lastRoll: null,
      balls: [],
      flight: null,
      finishedAt: null,
      rank: 0,
    };
    const sim = this.pending.get(playerId);
    const cooldownMs = me.flight && sim ? Math.max(0, me.flight.launchedAt + sim.outcome.endedAt - this.raceMs) : 0;
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
