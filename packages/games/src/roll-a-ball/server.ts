import type { GameContext, GameInstance, GameResults, GameServerDefinition } from '@funfair/shared';
import { rollABallMeta } from './meta';
import {
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  ROLL_COOLDOWN_MS,
  TRACK_LENGTH,
  isRollInput,
  ordinal,
  resolveRoll,
  type FeedEntry,
  type RacePhase,
  type RacerState,
  type RollABallHostState,
  type RollABallInput,
  type RollABallPlayerState,
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
  private readonly lastRollAt = new Map<string, number>();
  private readonly feed: FeedEntry[] = [];

  constructor(private readonly ctx: GameContext) {
    for (const p of ctx.players) {
      this.racers.set(p.id, { playerId: p.id, progress: 0, rolls: 0, lastRoll: null, finishedAt: null, rank: 1 });
    }
    this.updateRanks();
  }

  onInput(playerId: string, input: RollABallInput): void {
    if (this.phase !== 'racing') return;
    if (!isRollInput(input)) return;
    const racer = this.racers.get(playerId);
    if (!racer || racer.finishedAt !== null) return;

    const now = this.ctx.now();
    const last = this.lastRollAt.get(playerId) ?? -Infinity;
    if (now - last < ROLL_COOLDOWN_MS) return;
    this.lastRollAt.set(playerId, now);

    const result = resolveRoll(input.power, input.aim);
    racer.rolls += 1;
    racer.progress = Math.min(TRACK_LENGTH, racer.progress + result.points);
    racer.lastRoll = { ...result, seq: racer.rolls, power: input.power, aim: input.aim, at: this.raceMs };
    this.feed.unshift({ playerId, seq: racer.rolls, points: result.points, kind: result.kind, at: this.raceMs });
    if (this.feed.length > FEED_LENGTH) this.feed.length = FEED_LENGTH;

    if (racer.progress >= TRACK_LENGTH) {
      racer.finishedAt = this.raceMs;
      if (this.winnerId === null) {
        this.winnerId = playerId;
        this.phase = 'finished';
      }
    }
    this.updateRanks();
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
        break;
      case 'finished':
        this.raceMs += dtMs;
        this.lingerMs -= dtMs;
        if (this.lingerMs <= 0) this.done = true;
        break;
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
    const me = this.racers.get(playerId) ?? { playerId, progress: 0, rolls: 0, lastRoll: null, finishedAt: null, rank: 0 };
    const now = this.ctx.now();
    const last = this.lastRollAt.get(playerId);
    const cooldownMs = last === undefined ? 0 : Math.max(0, ROLL_COOLDOWN_MS - (now - last));
    let leaderProgress = 0;
    for (const r of this.racers.values()) leaderProgress = Math.max(leaderProgress, r.progress);
    return {
      phase: this.phase,
      countdownMs: this.countdownMs,
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
