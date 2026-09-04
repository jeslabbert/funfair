/**
 * Pure rules for Roll-a-Ball Derby. Shared by the server (authoritative) and
 * the phone controller (for instant feedback), so it must stay deterministic
 * and free of side effects.
 */

/** Track units the racer must cover to win. One point moves one unit. */
export const TRACK_LENGTH = 40;
/** Minimum time between rolls per player. Keeps it about aim, not tap speed. */
export const ROLL_COOLDOWN_MS = 900;
export const COUNTDOWN_MS = 3000;
/** How long the finish screen lingers before the room shows results. */
export const FINISH_LINGER_MS = 5000;
/** Rolls that are too far off-centre miss even if the distance was right. */
export const MAX_AIM = 1;

export interface Hole {
  id: string;
  label: string;
  points: number;
  /** Inclusive lower bound of roll power (0..1) that reaches this row. */
  minPower: number;
  /** Exclusive upper bound. */
  maxPower: number;
  /** Absolute aim (0..1) must be at or below this to drop in. */
  maxAim: number;
}

/** Rows of the board from the bottom of the ramp upwards. */
export const HOLES: readonly Hole[] = [
  { id: 'short', label: 'Short', points: 0, minPower: 0, maxPower: 0.18, maxAim: MAX_AIM },
  { id: 'ten', label: '10', points: 1, minPower: 0.18, maxPower: 0.42, maxAim: 0.6 },
  { id: 'twenty', label: '20', points: 2, minPower: 0.42, maxPower: 0.64, maxAim: 0.45 },
  { id: 'thirty', label: '30', points: 3, minPower: 0.64, maxPower: 0.82, maxAim: 0.32 },
  { id: 'fifty', label: '50', points: 5, minPower: 0.82, maxPower: 0.94, maxAim: 0.22 },
  { id: 'gutter', label: 'Gutter', points: 0, minPower: 0.94, maxPower: 1.0001, maxAim: MAX_AIM },
];

export type RollKind = 'hit' | 'wide' | 'short' | 'gutter';

export interface RollResult {
  holeIndex: number;
  points: number;
  kind: RollKind;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function resolveRoll(power: number, aim: number): RollResult {
  const p = clamp(power, 0, 1);
  const a = Math.abs(clamp(aim, -1, 1));
  const holeIndex = HOLES.findIndex((h) => p >= h.minPower && p < h.maxPower);
  const hole = HOLES[holeIndex] ?? HOLES[0]!;
  if (hole.id === 'short') return { holeIndex, points: 0, kind: 'short' };
  if (hole.id === 'gutter') return { holeIndex, points: 0, kind: 'gutter' };
  if (a > hole.maxAim) return { holeIndex, points: 0, kind: 'wide' };
  return { holeIndex, points: hole.points, kind: 'hit' };
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface RollOutcome extends RollResult {
  /** Per-player roll counter, starting at 1. */
  seq: number;
  power: number;
  aim: number;
  /** Race clock (ms since the race began) when the roll landed. */
  at: number;
}

export interface RacerState {
  playerId: string;
  progress: number;
  rolls: number;
  lastRoll: RollOutcome | null;
  finishedAt: number | null;
  /** 1-based rank while racing; final rank once finished. */
  rank: number;
}

export interface FeedEntry {
  playerId: string;
  seq: number;
  points: number;
  kind: RollKind;
  at: number;
}

export interface RollABallHostState {
  phase: RacePhase;
  countdownMs: number;
  raceMs: number;
  trackLength: number;
  racers: RacerState[];
  feed: FeedEntry[];
  winnerId: string | null;
}

export interface RollABallPlayerState {
  phase: RacePhase;
  countdownMs: number;
  trackLength: number;
  me: RacerState;
  cooldownMs: number;
  leaderProgress: number;
  playerCount: number;
  winnerId: string | null;
}

export type RollABallInput = { type: 'roll'; power: number; aim: number };

export function isRollInput(v: unknown): v is RollABallInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === 'roll' &&
    typeof o.power === 'number' &&
    Number.isFinite(o.power) &&
    typeof o.aim === 'number' &&
    Number.isFinite(o.aim)
  );
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
