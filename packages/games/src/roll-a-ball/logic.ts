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
/** Balls each player has on the table. */
export const BALLS_PER_PLAYER = 3;
/** Where the balls sit at the start (x, along the front bumper). */
export const BALL_START_XS = [-1.2, 0, 1.2] as const;
/** A ball that dropped into a hole (or the gutter) comes back through the chute after this. */
export const CHUTE_DELAY_MS = 1500;
/** Fresh balls from the chute are placed at the first free of these x positions. */
export const CHUTE_SLOTS = [0, -1.2, 1.2, -2.4, 2.4, -0.6, 0.6, -1.8, 1.8] as const;

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
  /** Ball-on-ball collisions. */
  ballRestitution: 0.8,
  /** Ball-on-peg collisions. */
  pegRestitution: 0.6,
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

/* ------------------------------------------------------------------------ */
/* Obstacles: a pure function of the race tick and a per-race seed, so the    */
/* phone and the server always agree on where everything is.                 */
/* ------------------------------------------------------------------------ */

/** Quiet time before the first obstacle wave. */
export const OBSTACLE_GRACE_TICKS = 720; // 6 s
/** Length of one wave. */
export const WAVE_TICKS = 1080; // 9 s
/** A wave fades in (intangible) and out over this long. */
export const WAVE_FADE_TICKS = 60; // 0.5 s

export type WaveKind = 'peg' | 'windmill' | 'lids' | 'pegs2';
export const WAVE_KINDS: readonly WaveKind[] = ['peg', 'windmill', 'lids', 'pegs2'];
export const WAVE_NAMES: Record<WaveKind, string> = { peg: 'Sweeper', windmill: 'Windmill', lids: 'Lids', pegs2: 'Double sweeper' };

export interface Wave {
  kind: WaveKind;
  index: number;
  /** Ticks into the wave. */
  t: number;
  /** 0..1 visibility; obstacles only touch balls at 1. */
  alpha: number;
}

/** Which wave is on (or arriving / leaving) at a tick. */
export function waveAt(tick: number, seed: number): Wave | null {
  if (tick < OBSTACLE_GRACE_TICKS) return null;
  const since = tick - OBSTACLE_GRACE_TICKS;
  const index = Math.floor(since / WAVE_TICKS);
  const t = since - index * WAVE_TICKS;
  const start = seed & 3;
  const step = 1 + 2 * ((seed >> 3) & 1); // 1 or 3: both walk every kind
  const kind = WAVE_KINDS[(start + index * step) % WAVE_KINDS.length]!;
  const alpha = t < WAVE_FADE_TICKS ? t / WAVE_FADE_TICKS : t >= WAVE_TICKS - WAVE_FADE_TICKS ? (WAVE_TICKS - t) / WAVE_FADE_TICKS : 1;
  return { kind, index, t, alpha };
}

const TAU = 6.283185307179586;

/** Sine from arithmetic only (Bhaskara), so every JavaScript engine agrees on the last bit. */
export function sinA(x: number): number {
  x = x - Math.floor(x / TAU) * TAU;
  let sign = 1;
  if (x > Math.PI) {
    x -= Math.PI;
    sign = -1;
  }
  const k = x * (Math.PI - x);
  return (sign * (16 * k)) / (5 * Math.PI * Math.PI - 4 * k);
}
export const cosA = (x: number) => sinA(x + Math.PI / 2);

/** A round post the balls bounce off. Velocity is in board units per second. */
export interface Peg {
  id: string;
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
}

export interface Windmill {
  x: number;
  y: number;
  /** Radians. */
  angle: number;
  spokes: number;
  reach: number;
}

export interface Obstacles {
  wave: Wave | null;
  /** True while the wave is fully in – only then does it touch balls. */
  tangible: boolean;
  pegs: Peg[];
  windmill: Windmill | null;
  /** Indices into HOLES that are covered. */
  closed: number[];
}

export const NO_OBSTACLES: Obstacles = { wave: null, tangible: false, pegs: [], windmill: null, closed: [] };

function pegPositions(kind: WaveKind, t: number): { id: string; x: number; y: number; r: number }[] {
  switch (kind) {
    case 'peg':
      return [{ id: 'p0', x: 2.2 * sinA((TAU * t) / 360), y: 6.1, r: 0.34 }];
    case 'pegs2':
      return [
        { id: 'p0', x: 2.0 * sinA((TAU * t) / 330), y: 6.1, r: 0.3 },
        { id: 'p1', x: -1.4 * sinA((TAU * t) / 270), y: 8.1, r: 0.3 },
      ];
    case 'windmill': {
      const hub = { x: 0, y: 7.1 };
      const angle = (TAU * t) / 300;
      const out = [];
      for (let i = 0; i < 3; i++) {
        const a = angle + (i * TAU) / 3;
        out.push({ id: `w${i}`, x: hub.x + 0.95 * cosA(a), y: hub.y + 0.95 * sinA(a), r: 0.27 });
      }
      return out;
    }
    default:
      return [];
  }
}

export function obstaclesAt(tick: number, seed: number): Obstacles {
  const wave = waveAt(tick, seed);
  if (!wave) return NO_OBSTACLES;
  const tangible = wave.alpha >= 1;
  const now = pegPositions(wave.kind, wave.t);
  const before = pegPositions(wave.kind, wave.t - 1);
  const after = pegPositions(wave.kind, wave.t + 1);
  const perSec = 1000 / PHYSICS.stepMs / 2;
  const pegs: Peg[] = now.map((p, i) => ({ ...p, vx: (after[i]!.x - before[i]!.x) * perSec, vy: (after[i]!.y - before[i]!.y) * perSec }));
  const windmill = wave.kind === 'windmill' ? { x: 0, y: 7.1, angle: (TAU * wave.t) / 300, spokes: 3, reach: 0.95 } : null;
  let closed: number[] = [];
  if (wave.kind === 'lids') {
    // Every two seconds the lids move on to the next zone: walk, trot, gallop.
    const zone: Zone = (['walk', 'trot', 'gallop'] as const)[Math.floor(wave.t / 240) % 3]!;
    closed = HOLES.map((h, i) => (h.zone === zone ? i : -1)).filter((i) => i >= 0);
  }
  return { wave, tangible, pegs, windmill, closed };
}

/** hit = dropped into a hole; gutter = flew off the back; back = rolled back to the bumper. */
export type RollKind = 'hit' | 'gutter' | 'back';

export type BallStatus = 'resting' | 'rolling' | 'held' | 'returning';

export interface Launch {
  /** Id of the ball being rolled. */
  ball: number;
  /** Where the player let go of it (on the ramp). */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Everything about one ball, serialisable so a snapshot replays exactly. */
export interface BallState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  status: BallStatus;
  /** Settled against the bumper and not moving. */
  frozen: boolean;
  /** Touching the bumper. */
  onBumper: boolean;
  /** Holes (indices into HOLES) whose lip this ball is currently over. */
  inside: number[];
  /** Balls this one was dropped onto: no collision until they've come apart once. */
  grace: number[];
  /** Tick the ball comes back from the chute on (while returning). */
  returnsAt: number;
  /** Tick this roll started (while rolling / resting after a roll). */
  launchTick: number;
  /** Whether this roll made it past the ramp lip – otherwise it was just a drop. */
  crossedLip: boolean;
}

export interface TableState {
  tick: number;
  /** Per-race seed that picks the obstacle order. */
  seed: number;
  /** Whether obstacle waves are on for this race. */
  obstacles: boolean;
  balls: BallState[];
}

export type TableEventType = 'lip' | 'skip' | 'rail' | 'bumper' | 'ball' | 'peg' | 'hit' | 'gutter' | 'settle' | 'return' | 'launch';

export interface TableEvent {
  tick: number;
  type: TableEventType;
  ball: number;
  x: number;
  y: number;
  /** Index into HOLES for hits. */
  hole?: number;
  /** For settles: whether the roll got past the lip (a real roll, not a drop). */
  crossedLip?: boolean;
}

export const msToTick = (ms: number) => Math.floor(ms / PHYSICS.stepMs);
export const tickToMs = (tick: number) => tick * PHYSICS.stepMs;
export const CHUTE_DELAY_TICKS = Math.round(CHUTE_DELAY_MS / PHYSICS.stepMs);

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Keep a release point on the ramp, between the rails. */
export function clampLaunchPosition(x: number, y: number): { x: number; y: number } {
  const railX = BOARD.halfWidth - PHYSICS.ballRadius;
  return {
    x: clamp(Number.isFinite(x) ? x : 0, -railX, railX),
    y: clamp(Number.isFinite(y) ? y : BOARD.ballStartY, BOARD.ballStartY, BOARD.rampLength - PHYSICS.ballRadius),
  };
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


function newBall(id: number, x: number, y: number): BallState {
  return { id, x, y, vx: 0, vy: 0, status: 'resting', frozen: true, onBumper: true, inside: [], grace: [], returnsAt: -1, launchTick: -1, crossedLip: false };
}

export function createTable(seed = 0, obstacles = false): TableState {
  return { tick: 0, seed: seed >>> 0, obstacles, balls: BALL_START_XS.map((x, id) => newBall(id, x, BOARD.ballStartY)) };
}

export function cloneTable(t: TableState): TableState {
  return { tick: t.tick, seed: t.seed, obstacles: t.obstacles, balls: t.balls.map((b) => ({ ...b, inside: [...b.inside], grace: [...b.grace] })) };
}

/** The obstacles on a table at its current tick (none if the race has them off). */
export function tableObstacles(t: TableState): Obstacles {
  return t.obstacles ? obstaclesAt(t.tick, t.seed) : NO_OBSTACLES;
}

/** Two tables are the same if every ball matches to floating-point noise. */
export function tablesMatch(a: TableState, b: TableState, eps = 1e-6): boolean {
  if (a.tick !== b.tick || a.balls.length !== b.balls.length) return false;
  for (let i = 0; i < a.balls.length; i++) {
    const p = a.balls[i]!;
    const q = b.balls[i]!;
    if (p.id !== q.id || p.status !== q.status || p.frozen !== q.frozen) return false;
    if (Math.abs(p.x - q.x) > eps || Math.abs(p.y - q.y) > eps || Math.abs(p.vx - q.vx) > eps || Math.abs(p.vy - q.vy) > eps) return false;
  }
  return true;
}

/** Lift a resting ball off the table: it stops taking part until it's rolled. */
export function grabBall(t: TableState, ballId: number): boolean {
  const b = t.balls.find((k) => k.id === ballId);
  if (!b || b.status !== 'resting') return false;
  b.status = 'held';
  b.vx = 0;
  b.vy = 0;
  b.frozen = false;
  return true;
}

/** Roll a ball (held, or resting – a grab is implied) from a point on the ramp. */
export function launchBall(t: TableState, launch: Launch, events?: TableEvent[]): boolean {
  const b = t.balls.find((k) => k.id === launch.ball);
  if (!b || (b.status !== 'held' && b.status !== 'resting')) return false;
  const pos = clampLaunchPosition(launch.x, launch.y);
  const vel = clampLaunch(launch.vx, launch.vy);
  b.x = pos.x;
  b.y = pos.y;
  b.vx = vel.vx;
  b.vy = vel.vy;
  b.status = 'rolling';
  b.frozen = false;
  b.onBumper = pos.y <= BOARD.ballStartY + 1e-6;
  b.inside = [];
  b.launchTick = t.tick;
  b.crossedLip = false;
  b.grace = t.balls
    .filter((o) => o.id !== b.id && (o.status === 'resting' || o.status === 'rolling') && Math.hypot(o.x - pos.x, o.y - pos.y) < PHYSICS.ballRadius * 2)
    .map((o) => o.id);
  events?.push({ tick: t.tick, type: 'launch', ball: b.id, x: b.x, y: b.y });
  return true;
}

/** First chute slot along the bumper that isn't blocked by a ball on the table. */
export function freeSlot(t: TableState): number {
  const gap = PHYSICS.ballRadius * 2 + 0.05;
  for (const x of CHUTE_SLOTS) {
    if (t.balls.every((b) => b.status === 'returning' || b.status === 'held' || Math.abs(b.x - x) >= gap || Math.abs(b.y - BOARD.ballStartY) > gap)) return x;
  }
  return 0;
}

/**
 * Advance the table by one step. Every ball on the table takes part: balls
 * at rest are real bodies, so a returning ball can knock them and they roll
 * and settle in turn. Deterministic: fixed timestep, plain arithmetic and
 * sqrt only, so a phone and the server compute the very same table.
 */
export function stepTable(t: TableState, events: TableEvent[]): void {
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
    ballRestitution,
    settleSpeed,
    ballRadius,
    stepMs,
  } = PHYSICS;
  const dt = stepMs / 1000;
  const railX = BOARD.halfWidth - ballRadius;
  t.tick += 1;
  const tick = t.tick;
  const balls = t.balls;
  const onTable = (b: BallState) => b.status === 'resting' || b.status === 'rolling';
  const obstacles = tableObstacles(t);

  // Integrate the moving bodies
  for (const b of balls) {
    if (!onTable(b) || b.frozen) continue;
    let ax = 0;
    let ay = -slope;
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed > 1e-6) {
      ax -= (friction * b.vx) / speed;
      ay -= (friction * b.vy) / speed;
    }
    b.vx += ax * dt;
    b.vy += ay * dt;
    if (b.onBumper && b.vy < 0) b.vy = 0;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Side rails
    if (b.x > railX) {
      b.x = railX - (b.x - railX);
      b.vx = -Math.abs(b.vx) * railRestitution;
      events.push({ tick, type: 'rail', ball: b.id, x: b.x, y: b.y });
    } else if (b.x < -railX) {
      b.x = -railX + (-railX - b.x);
      b.vx = Math.abs(b.vx) * railRestitution;
      events.push({ tick, type: 'rail', ball: b.id, x: b.x, y: b.y });
    }

    if (b.y > BOARD.rampLength) b.crossedLip = true;

    // Back gutter
    if (b.y > BOARD.gutterY) {
      events.push({ tick, type: 'gutter', ball: b.id, x: b.x, y: b.y });
      b.status = 'returning';
      b.returnsAt = tick + CHUTE_DELAY_TICKS;
      b.vx = 0;
      b.vy = 0;
      continue;
    }

    // Front bumper: bounce back up the slope, a little less each time, then settle.
    if (b.y < BOARD.ballStartY && b.vy < 0) {
      b.y = BOARD.ballStartY;
      if (-b.vy > settleSpeed) {
        b.vy = -b.vy * bumperRestitution;
        events.push({ tick, type: 'bumper', ball: b.id, x: b.x, y: b.y });
      } else {
        b.vy = 0;
        b.onBumper = true;
      }
    } else if (b.y > BOARD.ballStartY + 0.02) {
      b.onBumper = false;
    }
    if (b.onBumper && Math.abs(b.vx) < settleSpeed && Math.abs(b.vy) < 1e-6) {
      b.vx = 0;
      b.frozen = true;
      if (b.status === 'rolling') {
        b.status = 'resting';
        events.push({ tick, type: 'settle', ball: b.id, x: b.x, y: b.y, crossedLip: b.crossedLip });
      }
    }
  }

  // Pegs: heavy moving posts – push the ball out and bounce it off, relative to the peg's motion.
  if (obstacles.tangible && obstacles.pegs.length) {
    for (const b of balls) {
      if (!onTable(b) || b.frozen) continue;
      for (const peg of obstacles.pegs) {
        const dx = b.x - peg.x;
        const dy = b.y - peg.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minD = ballRadius + peg.r;
        if (d >= minD) continue;
        const nx = d > 1e-6 ? dx / d : 0;
        const ny = d > 1e-6 ? dy / d : 1;
        b.x = peg.x + nx * minD;
        b.y = peg.y + ny * minD;
        const vn = (b.vx - peg.vx) * nx + (b.vy - peg.vy) * ny;
        if (vn < 0) {
          b.vx -= (1 + PHYSICS.pegRestitution) * vn * nx;
          b.vy -= (1 + PHYSICS.pegRestitution) * vn * ny;
        }
        b.frozen = false;
        if (b.y > BOARD.ballStartY + 0.02) b.onBumper = false;
        events.push({ tick, type: 'peg', ball: b.id, x: b.x, y: b.y });
      }
    }
  }

  // Ball on ball: push apart, swap the approaching part of their velocities (equal masses).
  for (let i = 0; i < balls.length; i++) {
    const p = balls[i]!;
    if (!onTable(p)) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const q = balls[j]!;
      if (!onTable(q)) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const minD = ballRadius * 2;
      const pg = p.grace.indexOf(q.id);
      const qg = q.grace.indexOf(p.id);
      if (pg >= 0 || qg >= 0) {
        if (d >= minD) {
          if (pg >= 0) p.grace.splice(pg, 1);
          if (qg >= 0) q.grace.splice(qg, 1);
        }
        continue;
      }
      if (d >= minD) continue;
      const nx = d > 1e-6 ? dx / d : 0;
      const ny = d > 1e-6 ? dy / d : 1;
      const push = (minD - d) / 2;
      p.x -= nx * push;
      p.y -= ny * push;
      q.x += nx * push;
      q.y += ny * push;
      const vn = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
      if (vn < 0) {
        const k = ((1 + ballRestitution) / 2) * vn;
        p.vx += k * nx;
        p.vy += k * ny;
        q.vx -= k * nx;
        q.vy -= k * ny;
        events.push({ tick, type: 'ball', ball: q.id, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
      }
      for (const b of [p, q]) {
        if (b.frozen) {
          b.frozen = false;
          if (b.status === 'resting') {
            // Knocked: it's rolling again, but it isn't a fresh roll.
            b.status = 'rolling';
          }
        }
        if (b.y > BOARD.ballStartY + 0.02) b.onBumper = false;
      }
    }
  }

  // Holes
  for (const b of balls) {
    if (!onTable(b) || b.frozen) continue;
    for (let h = 0; h < HOLES.length; h++) {
      const hole = HOLES[h]!;
      const dy = b.y - hole.y;
      if (dy > captureRadius || dy < -captureRadius || (obstacles.tangible && obstacles.closed.includes(h))) {
        // Out of reach, or under a lid: the ball just rolls over it.
        removeFrom(b.inside, h);
        continue;
      }
      const dx = b.x - hole.x;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= captureRadius) {
        removeFrom(b.inside, h);
        continue;
      }
      if (b.inside.includes(h)) continue;
      b.inside.push(h);

      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (v > captureSpeed) {
        // Too quick: the lip is just a bump on the way past.
        b.vx *= skipDamping;
        b.vy *= skipDamping;
        events.push({ tick, type: 'skip', ball: b.id, x: hole.x, y: hole.y, hole: h });
      } else if (v < lipSpeed) {
        // Too slow to climb the lip: bounce off it and let the slope take over.
        const nx = d > 1e-6 ? dx / d : 0;
        const ny = d > 1e-6 ? dy / d : -1;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= (1 + lipRestitution) * vn * nx;
          b.vy -= (1 + lipRestitution) * vn * ny;
        }
        b.x = hole.x + nx * captureRadius;
        b.y = hole.y + ny * captureRadius;
        events.push({ tick, type: 'lip', ball: b.id, x: hole.x, y: hole.y, hole: h });
      } else {
        events.push({ tick, type: 'hit', ball: b.id, x: b.x, y: b.y, hole: h });
        b.status = 'returning';
        b.returnsAt = tick + CHUTE_DELAY_TICKS;
        b.vx = 0;
        b.vy = 0;
        break;
      }
    }
  }

  // Back from the chute
  for (const b of balls) {
    if (b.status !== 'returning' || tick < b.returnsAt) continue;
    const x = freeSlot(t);
    b.x = x;
    b.y = BOARD.ballStartY;
    b.vx = 0;
    b.vy = 0;
    b.status = 'resting';
    b.frozen = true;
    b.onBumper = true;
    b.inside = [];
    b.grace = [];
    b.returnsAt = -1;
    events.push({ tick, type: 'return', ball: b.id, x: b.x, y: b.y });
  }
}

function removeFrom(list: number[], v: number): void {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1);
}

/** True while any ball is rolling (or waiting in the chute). */
export function tableBusy(t: TableState): boolean {
  return t.balls.some((b) => b.status === 'rolling' || b.status === 'returning');
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface BallView {
  id: number;
  x: number;
  y: number;
  status: BallStatus;
}

export interface RollRecord {
  kind: RollKind;
  points: number;
  zone: Zone | null;
  row: number | null;
  col: number | null;
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
  balls: BallView[];
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
  /** Whether this race has obstacle waves. */
  obstacles: boolean;
  /** The obstacle wave on the tables right now. */
  wave: { kind: WaveKind; name: string; t: number; alpha: number } | null;
}

export interface RollABallPlayerState {
  phase: RacePhase;
  countdownMs: number;
  raceMs: number;
  trackLength: number;
  me: RacerState;
  /** The authoritative table, for the phone to check its prediction against. */
  table: TableState;
  leaderProgress: number;
  playerCount: number;
  winnerId: string | null;
}

export type RollABallInput =
  | { type: 'grab'; ball: number; tick: number }
  | { type: 'roll'; ball: number; x: number; y: number; vx: number; vy: number; tick: number };

export function isRollInput(v: unknown): v is RollABallInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k]);
  if (o.type === 'grab') return num('ball') && num('tick');
  if (o.type === 'roll') return num('ball') && num('x') && num('y') && num('vx') && num('vy') && num('tick');
  return false;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
