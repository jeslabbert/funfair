/**
 * Pure rules for Roll-a-Ball Derby. Shared by the server (authoritative) and
 * the phone controller (for instant feedback), so it must stay deterministic
 * and free of side effects.
 */

/** Track units the racer must cover to win. One point moves one unit. */
export const TRACK_LENGTH = 30;
/** Minimum time between rolls per player. Keeps it about aim, not tap speed. */
export const ROLL_COOLDOWN_MS = 900;
export const COUNTDOWN_MS = 3000;
/** How long the finish screen lingers before the room shows results. */
export const FINISH_LINGER_MS = 5000;
export type Zone = 'walk' | 'trot' | 'gallop';

export const ZONE_POINTS: Record<Zone, number> = { walk: 1, trot: 2, gallop: 3 };
export const ZONE_LABEL: Record<Zone, string> = { walk: 'Walk', trot: 'Trot', gallop: 'Gallop' };

/**
 * The board is a pyramid of holes, ROWS deep: the front row (nearest the ramp)
 * has ROWS holes, each row back has one fewer, and the apex has one.
 *
 *            G            back  – gallop: the apex triangle
 *          G   G
 *        G   G   G
 *      T   T   T   T      middle – trot: an arrow/chevron under the triangle…
 *    T   W   W   W   T    …whose arms run down the outside edges
 *  T   W   W   W   W   T
 *T   W   W   W   W   W   T front – walk: everything inside the arrow
 */
export const ROWS = 7;
/** Rows (from the front, 0-based) that belong to the gallop triangle. */
export const GALLOP_FROM_ROW = 4;
/** The full row that forms the tip of the trot arrow. */
export const TROT_ROW = 3;

export interface Hole {
  row: number;
  col: number;
  /** Lateral position in board units; the front row spans -3..3, the apex is 0. */
  x: number;
  zone: Zone;
  points: number;
}

export function holesInRow(row: number): number {
  return ROWS - row;
}

export function zoneOf(row: number, col: number): Zone {
  if (row >= GALLOP_FROM_ROW) return 'gallop';
  if (row === TROT_ROW) return 'trot';
  return col === 0 || col === holesInRow(row) - 1 ? 'trot' : 'walk';
}

export const HOLES: readonly Hole[] = (() => {
  const holes: Hole[] = [];
  for (let row = 0; row < ROWS; row++) {
    const n = holesInRow(row);
    for (let col = 0; col < n; col++) {
      const zone = zoneOf(row, col);
      holes.push({ row, col, x: col - (n - 1) / 2, zone, points: ZONE_POINTS[zone] });
    }
  }
  return holes;
})();

/** Power below this doesn't reach the board; above the top it flies into the back gutter. */
export const MIN_POWER = 0.15;
export const MAX_POWER = 0.95;
/** Full sideways aim drifts the ball this many board units – just past the front row's edge. */
export const AIM_UNITS = (ROWS - 1) / 2 + 0.5;

export type RollKind = 'hit' | 'wide' | 'short' | 'gutter';

export interface RollResult {
  kind: RollKind;
  points: number;
  zone: Zone | null;
  /** Row the ball reached (0 = front). Set for hits and wides. */
  row: number | null;
  /** Hole within that row for hits. */
  col: number | null;
  /** Where the ball came to rest, in board units – used for the phone animation. */
  x: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 0..1 depth into the board for a given power, or null if it fell short / overshot. */
export function depthForPower(power: number): number | null {
  const p = clamp(power, 0, 1);
  if (p < MIN_POWER || p > MAX_POWER) return null;
  return (p - MIN_POWER) / (MAX_POWER - MIN_POWER);
}

export function resolveRoll(power: number, aim: number): RollResult {
  const p = clamp(power, 0, 1);
  const x = clamp(aim, -1, 1) * AIM_UNITS;
  const depth = depthForPower(p);
  if (depth === null) {
    return { kind: p < MIN_POWER ? 'short' : 'gutter', points: 0, zone: null, row: null, col: null, x };
  }
  const row = Math.round(depth * (ROWS - 1));
  const n = holesInRow(row);
  const col = Math.round(x + (n - 1) / 2);
  if (col < 0 || col >= n) return { kind: 'wide', points: 0, zone: null, row, col: null, x };
  const zone = zoneOf(row, col);
  return { kind: 'hit', points: ZONE_POINTS[zone], zone, row, col, x: col - (n - 1) / 2 };
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
  zone: Zone | null;
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
