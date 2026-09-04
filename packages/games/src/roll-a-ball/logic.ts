/**
 * Pure rules for Roll-a-Ball Derby. Shared by the server (authoritative) and
 * the phone controller (for prediction and animation), so it must stay
 * deterministic: fixed timestep, plain arithmetic and sqrt only – no trig,
 * no randomness – so both sides compute the very same roll.
 */

/** Track units the racer must cover to win. One point moves one unit. */
export const TRACK_LENGTH = 30;
export const COUNTDOWN_MS = 3000;
/** How long the finish screen lingers before the room shows results. */
export const FINISH_LINGER_MS = 5000;
/** Pause between a ball finishing (dropping in / returning) and the next one being ready. */
export const RETURN_DELAY_MS = 350;

export type Zone = 'walk' | 'trot' | 'gallop';

export const ZONE_POINTS: Record<Zone, number> = { walk: 1, trot: 2, gallop: 3 };
export const ZONE_LABEL: Record<Zone, string> = { walk: 'Walk', trot: 'Trot', gallop: 'Gallop' };

/**
 * The board is a pyramid of holes, ROWS deep: the front row (nearest the ramp)
 * has ROWS holes, each row back has one fewer, and the apex has one.
 *
 *          G          back  – gallop: the apex triangle
 *        G   G
 *      T   T   T      middle – trot: an arrow/chevron under the triangle…
 *    T   W   W   T    …whose arms run down the outside edges
 *  T   W   W   W   T  front – walk: everything inside the arrow
 */
export const ROWS = 5;
/** Rows (from the front, 0-based) that belong to the gallop triangle. */
export const GALLOP_FROM_ROW = 3;
/** The full row that forms the tip of the trot arrow. */
export const TROT_ROW = 2;

/**
 * Board geometry in "board units": 1 unit = the lateral spacing between
 * neighbouring holes. y runs up the slope from the bottom of the ramp.
 */
export const BOARD = {
  /** Side rails sit at ±halfWidth. */
  halfWidth: 3.0,
  /** The ramp meets the board at this y – the bottom half of the table is runway. */
  rampLength: 5.0,
  /** Holes are packed into the top half, one unit apart. */
  firstRowY: 5.6,
  rowSpacing: 1.0,
  /** Past this the ball drops into the back gutter. */
  gutterY: 10.4,
  /** Where a ball sits in the player's hand. */
  ballStartY: 0.3,
} as const;

export const PHYSICS = {
  /** Deceleration up the slope (units/s²). Doubles as downhill acceleration. */
  slope: 6.0,
  /** Rolling resistance, always against motion (units/s²). */
  friction: 0.6,
  /** A ball whose centre passes within this of a hole centre meets its lip. */
  captureRadius: 0.45,
  /** Slower than this and the ball can't climb the lip – it bounces back. */
  lipSpeed: 1.2,
  /** Faster than this and the ball skips straight over the hole. */
  captureSpeed: 4.0,
  /** Speed kept after skipping a hole (the lip is a bump). */
  skipDamping: 0.9,
  lipRestitution: 0.35,
  railRestitution: 0.55,
  /** The front stop at the bottom of the ramp: a returning ball rebounds off it… */
  bumperRestitution: 0.45,
  /** …until it arrives slower than this, when it settles and the roll is over. */
  settleSpeed: 0.7,
  ballRadius: 0.3,
  /** Launch speed at full power. */
  maxLaunchSpeed: 15,
  /** Sideways component of the launch may not exceed this fraction of the speed (~37°). */
  maxLateralRatio: 0.6,
  stepMs: 1000 / 120,
  maxDurationMs: 8000,
} as const;

export interface Hole {
  row: number;
  col: number;
  /** Lateral position in board units; the front row spans -3..3, the apex is 0. */
  x: number;
  y: number;
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

export function rowY(row: number): number {
  return BOARD.firstRowY + row * BOARD.rowSpacing;
}

export const HOLES: readonly Hole[] = (() => {
  const holes: Hole[] = [];
  for (let row = 0; row < ROWS; row++) {
    const n = holesInRow(row);
    for (let col = 0; col < n; col++) {
      const zone = zoneOf(row, col);
      holes.push({ row, col, x: col - (n - 1) / 2, y: rowY(row), zone, points: ZONE_POINTS[zone] });
    }
  }
  return holes;
})();

/** hit = dropped into a hole; gutter = flew off the back; back = rolled back to the player. */
export type RollKind = 'hit' | 'gutter' | 'back';

export type RollEventType = 'lip' | 'skip' | 'rail' | 'bumper' | 'hit' | 'gutter' | 'back';

export interface RollEvent {
  /** Milliseconds after launch. */
  t: number;
  type: RollEventType;
  x: number;
  y: number;
}

export interface RollOutcome {
  kind: RollKind;
  points: number;
  zone: Zone | null;
  row: number | null;
  col: number | null;
  /** Milliseconds after launch when the ball dropped in / left the board / got back. */
  endedAt: number;
}

export interface RollSimulation {
  outcome: RollOutcome;
  /** Ball centre every stepMs: [x0, y0, x1, y1, …]. */
  frames: number[];
  events: RollEvent[];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Clamp a requested launch velocity to what the ramp allows. */
export function clampLaunch(vx: number, vy: number): { vx: number; vy: number } {
  let y = Math.max(0, vy);
  let x = vx;
  const speed = Math.sqrt(x * x + y * y);
  if (speed > PHYSICS.maxLaunchSpeed) {
    const k = PHYSICS.maxLaunchSpeed / speed;
    x *= k;
    y *= k;
  }
  // Too much sideways? Rotate to the widest allowed angle, keeping the speed.
  const s = Math.sqrt(x * x + y * y);
  if (s > 0 && Math.abs(x) > PHYSICS.maxLateralRatio * s) {
    const r = PHYSICS.maxLateralRatio;
    x = (x < 0 ? -r : r) * s;
    y = Math.sqrt(1 - r * r) * s;
  }
  return { vx: x, vy: y };
}

/** Roll a ball up the board and follow it until it drops in, flies off the back, or comes home. */
export function simulateRoll(launchVx: number, launchVy: number): RollSimulation {
  const {
    slope,
    friction,
    captureRadius,
    lipSpeed,
    captureSpeed,
    skipDamping,
    lipRestitution,
    railRestitution,
    bumperRestitution,
    settleSpeed,
    ballRadius,
    stepMs,
    maxDurationMs,
  } = PHYSICS;
  const dt = stepMs / 1000;
  const railX = BOARD.halfWidth - ballRadius;
  const launch = clampLaunch(launchVx, launchVy);

  let x = 0;
  let y: number = BOARD.ballStartY;
  let vx = launch.vx;
  let vy = launch.vy;
  let t = 0;
  const frames: number[] = [x, y];
  const events: RollEvent[] = [];
  /** Holes whose lip the ball is currently over, so each pass triggers once. */
  const inside = new Set<Hole>();
  /** Sitting against the front bumper. */
  let resting = false;

  const finish = (kind: RollKind, hole: Hole | null): RollSimulation => {
    events.push({ t, type: kind, x, y });
    return {
      outcome: {
        kind,
        points: hole?.points ?? 0,
        zone: hole?.zone ?? null,
        row: hole?.row ?? null,
        col: hole?.col ?? null,
        endedAt: t,
      },
      frames,
      events,
    };
  };

  while (t < maxDurationMs) {
    // Slope pulls straight down the board; friction opposes motion.
    let ax = 0;
    let ay = -slope;
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > 1e-6) {
      ax -= (friction * vx) / speed;
      ay -= (friction * vy) / speed;
    }
    vx += ax * dt;
    vy += ay * dt;
    if (resting && vy < 0) vy = 0;
    x += vx * dt;
    y += vy * dt;
    t += stepMs;

    // Side rails
    if (x > railX) {
      x = railX - (x - railX);
      vx = -Math.abs(vx) * railRestitution;
      events.push({ t, type: 'rail', x, y });
    } else if (x < -railX) {
      x = -railX + (-railX - x);
      vx = Math.abs(vx) * railRestitution;
      events.push({ t, type: 'rail', x, y });
    }

    frames.push(x, y);

    if (y > BOARD.gutterY) return finish('gutter', null);

    // Front bumper: bounce back up the slope, a little less each time, then settle.
    if (y < BOARD.ballStartY && vy < 0) {
      y = BOARD.ballStartY;
      if (-vy > settleSpeed) {
        vy = -vy * bumperRestitution;
        events.push({ t, type: 'bumper', x, y });
      } else {
        vy = 0;
        resting = true;
      }
    } else if (y > BOARD.ballStartY + 0.02) {
      resting = false;
    }
    if (resting && Math.abs(vx) < settleSpeed) return finish('back', null);

    // Holes (only the rows the ball could be touching)
    for (const hole of HOLES) {
      const dy = y - hole.y;
      if (dy > captureRadius || dy < -captureRadius) {
        inside.delete(hole);
        continue;
      }
      const dx = x - hole.x;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= captureRadius) {
        inside.delete(hole);
        continue;
      }
      if (inside.has(hole)) continue;
      inside.add(hole);

      const v = Math.sqrt(vx * vx + vy * vy);
      if (v > captureSpeed) {
        // Too quick: the lip is just a bump on the way past.
        vx *= skipDamping;
        vy *= skipDamping;
        events.push({ t, type: 'skip', x: hole.x, y: hole.y });
      } else if (v < lipSpeed) {
        // Too slow to climb the lip: bounce off it and let the slope take over.
        const nx = d > 1e-6 ? dx / d : 0;
        const ny = d > 1e-6 ? dy / d : -1;
        const vn = vx * nx + vy * ny;
        if (vn < 0) {
          vx -= (1 + lipRestitution) * vn * nx;
          vy -= (1 + lipRestitution) * vn * ny;
        }
        x = hole.x + nx * captureRadius;
        y = hole.y + ny * captureRadius;
        events.push({ t, type: 'lip', x: hole.x, y: hole.y });
      } else {
        return finish('hit', hole);
      }
    }
  }
  return finish('back', null);
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface BallInPlay {
  vx: number;
  vy: number;
  /** Race clock (ms) at launch. */
  launchedAt: number;
}

export interface RollRecord extends RollOutcome {
  /** Per-player roll counter, starting at 1. */
  seq: number;
  /** Race clock (ms) when the outcome was applied. */
  at: number;
}

export interface RacerState {
  playerId: string;
  progress: number;
  rolls: number;
  lastRoll: RollRecord | null;
  ball: BallInPlay | null;
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
  raceMs: number;
  trackLength: number;
  me: RacerState;
  /** Milliseconds until the next ball is ready (0 = roll now). */
  cooldownMs: number;
  leaderProgress: number;
  playerCount: number;
  winnerId: string | null;
}

export type RollABallInput = { type: 'roll'; vx: number; vy: number };

export function isRollInput(v: unknown): v is RollABallInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.type === 'roll' && typeof o.vx === 'number' && Number.isFinite(o.vx) && typeof o.vy === 'number' && Number.isFinite(o.vy);
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
