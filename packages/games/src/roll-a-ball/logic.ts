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

export type RollEventType = 'lip' | 'skip' | 'rail' | 'bumper' | 'ball' | 'hit' | 'gutter' | 'back';

export interface RollEvent {
  /** Milliseconds after launch. */
  t: number;
  type: RollEventType;
  /** Index into the simulation's bodies. */
  ball: number;
  x: number;
  y: number;
}

/** A ball sitting on the table. */
export interface BallAtRest {
  id: number;
  x: number;
  y: number;
}

export interface Launch {
  /** Id of the ball being rolled – it must be one of the balls at rest. */
  ball: number;
  /** Where the player let go of it (on the ramp). */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Capture {
  /** Body index. */
  ball: number;
  hole: Hole;
  t: number;
}

export interface RollOutcome {
  /** What happened to the ball that was rolled. */
  kind: RollKind;
  /** Total points – a knocked ball that drops in counts too. */
  points: number;
  zone: Zone | null;
  row: number | null;
  col: number | null;
  /** Milliseconds after launch when every ball had settled / dropped in / left the board. */
  endedAt: number;
  /** How far up the table the rolled ball got. Below the ramp lip it was just a drop, not a roll. */
  peakY: number;
}

export interface RollSimulation {
  outcome: RollOutcome;
  /** Ids of the bodies, in frame order. */
  ids: number[];
  /** Index of the rolled ball among the bodies. */
  launched: number;
  /** Every stepMs, a centre per body: [x0, y0, x1, y1, …]; NaN once a body has dropped in. */
  frames: number[];
  events: RollEvent[];
  captures: Capture[];
  /** Where the surviving balls came to rest. */
  final: BallAtRest[];
}

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

/**
 * Roll one ball and follow every ball on the table until all have settled,
 * dropped in, or left the board. Balls at rest are real bodies: a returning
 * ball can knock them and they roll and settle in turn.
 */
export function simulateRoll(launch: Launch, atRest: BallAtRest[]): RollSimulation {
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
    maxDurationMs,
  } = PHYSICS;
  const dt = stepMs / 1000;
  const railX = BOARD.halfWidth - ballRadius;
  const n = atRest.length;
  const ids = atRest.map((b) => b.id);
  const launched = Math.max(0, ids.indexOf(launch.ball));
  const start = clampLaunchPosition(launch.x, launch.y);
  const vel = clampLaunch(launch.vx, launch.vy);

  const x = atRest.map((b) => b.x);
  const y = atRest.map((b) => b.y);
  const vx = new Array<number>(n).fill(0);
  const vy = new Array<number>(n).fill(0);
  /** Settled against the bumper and not moving. */
  const frozen = new Array<boolean>(n).fill(true);
  /** Touching the bumper. */
  const onBumper = new Array<boolean>(n).fill(true);
  const alive = new Array<boolean>(n).fill(true);
  const inside: Set<Hole>[] = atRest.map(() => new Set<Hole>());

  x[launched] = start.x;
  y[launched] = start.y;
  vx[launched] = vel.vx;
  vy[launched] = vel.vy;
  frozen[launched] = false;
  onBumper[launched] = start.y <= BOARD.ballStartY + 1e-6;

  /** Bodies the rolled ball was dropped onto: no collision until they've come apart once. */
  const grace = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (i === launched) continue;
    const dx = x[i]! - start.x;
    const dy = y[i]! - start.y;
    if (Math.sqrt(dx * dx + dy * dy) < ballRadius * 2) grace.add(i);
  }

  let t = 0;
  let peakY = start.y;
  let launchedKind: RollKind | null = null;
  const frames: number[] = [];
  const events: RollEvent[] = [];
  const captures: Capture[] = [];
  const pushFrame = () => {
    for (let i = 0; i < n; i++) frames.push(alive[i] ? x[i]! : NaN, alive[i] ? y[i]! : NaN);
  };
  pushFrame();

  const finish = (): RollSimulation => {
    const kind: RollKind = launchedKind ?? 'back';
    const mine = captures.find((c) => c.ball === launched) ?? captures[0] ?? null;
    events.push({ t, type: kind, ball: launched, x: x[launched]!, y: y[launched]! });
    return {
      outcome: {
        kind,
        points: captures.reduce((sum, c) => sum + c.hole.points, 0),
        zone: mine?.hole.zone ?? null,
        row: mine?.hole.row ?? null,
        col: mine?.hole.col ?? null,
        endedAt: t,
        peakY,
      },
      ids,
      launched,
      frames,
      events,
      captures,
      final: atRest.filter((_, i) => alive[i]).map((b, k) => {
        const i = ids.indexOf(b.id);
        void k;
        return { id: b.id, x: x[i]!, y: y[i]! };
      }),
    };
  };

  while (t < maxDurationMs) {
    t += stepMs;

    // Integrate the moving bodies
    for (let i = 0; i < n; i++) {
      if (!alive[i] || frozen[i]) continue;
      let ax = 0;
      let ay = -slope;
      const speed = Math.sqrt(vx[i]! * vx[i]! + vy[i]! * vy[i]!);
      if (speed > 1e-6) {
        ax -= (friction * vx[i]!) / speed;
        ay -= (friction * vy[i]!) / speed;
      }
      vx[i] = vx[i]! + ax * dt;
      vy[i] = vy[i]! + ay * dt;
      if (onBumper[i] && vy[i]! < 0) vy[i] = 0;
      x[i] = x[i]! + vx[i]! * dt;
      y[i] = y[i]! + vy[i]! * dt;

      // Side rails
      if (x[i]! > railX) {
        x[i] = railX - (x[i]! - railX);
        vx[i] = -Math.abs(vx[i]!) * railRestitution;
        events.push({ t, type: 'rail', ball: i, x: x[i]!, y: y[i]! });
      } else if (x[i]! < -railX) {
        x[i] = -railX + (-railX - x[i]!);
        vx[i] = Math.abs(vx[i]!) * railRestitution;
        events.push({ t, type: 'rail', ball: i, x: x[i]!, y: y[i]! });
      }

      // Back gutter
      if (y[i]! > BOARD.gutterY) {
        alive[i] = false;
        if (i === launched) launchedKind = 'gutter';
        events.push({ t, type: 'gutter', ball: i, x: x[i]!, y: y[i]! });
        continue;
      }

      // Front bumper: bounce back up the slope, a little less each time, then settle.
      if (y[i]! < BOARD.ballStartY && vy[i]! < 0) {
        y[i] = BOARD.ballStartY;
        if (-vy[i]! > settleSpeed) {
          vy[i] = -vy[i]! * bumperRestitution;
          events.push({ t, type: 'bumper', ball: i, x: x[i]!, y: y[i]! });
        } else {
          vy[i] = 0;
          onBumper[i] = true;
        }
      } else if (y[i]! > BOARD.ballStartY + 0.02) {
        onBumper[i] = false;
      }
      if (onBumper[i] && Math.abs(vx[i]!) < settleSpeed && Math.abs(vy[i]!) < 1e-6) {
        vx[i] = 0;
        frozen[i] = true;
      }
      if (i === launched && y[i]! > peakY) peakY = y[i]!;
    }

    // Ball on ball: push apart, swap the approaching part of their velocities (equal masses).
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const dx = x[j]! - x[i]!;
        const dy = y[j]! - y[i]!;
        const d = Math.sqrt(dx * dx + dy * dy);
        const minD = ballRadius * 2;
        const other = i === launched ? j : j === launched ? i : -1;
        if (other >= 0 && grace.has(other)) {
          if (d >= minD) grace.delete(other);
          continue;
        }
        if (d >= minD) continue;
        const nx = d > 1e-6 ? dx / d : 0;
        const ny = d > 1e-6 ? dy / d : 1;
        const push = (minD - d) / 2;
        x[i] = x[i]! - nx * push;
        y[i] = y[i]! - ny * push;
        x[j] = x[j]! + nx * push;
        y[j] = y[j]! + ny * push;
        const vn = (vx[j]! - vx[i]!) * nx + (vy[j]! - vy[i]!) * ny;
        if (vn < 0) {
          const k = ((1 + ballRestitution) / 2) * vn;
          vx[i] = vx[i]! + k * nx;
          vy[i] = vy[i]! + k * ny;
          vx[j] = vx[j]! - k * nx;
          vy[j] = vy[j]! - k * ny;
          events.push({ t, type: 'ball', ball: j, x: (x[i]! + x[j]!) / 2, y: (y[i]! + y[j]!) / 2 });
        }
        frozen[i] = false;
        frozen[j] = false;
        if (y[i]! > BOARD.ballStartY + 0.02) onBumper[i] = false;
        if (y[j]! > BOARD.ballStartY + 0.02) onBumper[j] = false;
      }
    }

    // Holes
    for (let i = 0; i < n; i++) {
      if (!alive[i] || frozen[i]) continue;
      for (const hole of HOLES) {
        const dy = y[i]! - hole.y;
        if (dy > captureRadius || dy < -captureRadius) {
          inside[i]!.delete(hole);
          continue;
        }
        const dx = x[i]! - hole.x;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= captureRadius) {
          inside[i]!.delete(hole);
          continue;
        }
        if (inside[i]!.has(hole)) continue;
        inside[i]!.add(hole);

        const v = Math.sqrt(vx[i]! * vx[i]! + vy[i]! * vy[i]!);
        if (v > captureSpeed) {
          // Too quick: the lip is just a bump on the way past.
          vx[i] = vx[i]! * skipDamping;
          vy[i] = vy[i]! * skipDamping;
          events.push({ t, type: 'skip', ball: i, x: hole.x, y: hole.y });
        } else if (v < lipSpeed) {
          // Too slow to climb the lip: bounce off it and let the slope take over.
          const nx = d > 1e-6 ? dx / d : 0;
          const ny = d > 1e-6 ? dy / d : -1;
          const vn = vx[i]! * nx + vy[i]! * ny;
          if (vn < 0) {
            vx[i] = vx[i]! - (1 + lipRestitution) * vn * nx;
            vy[i] = vy[i]! - (1 + lipRestitution) * vn * ny;
          }
          x[i] = hole.x + nx * captureRadius;
          y[i] = hole.y + ny * captureRadius;
          events.push({ t, type: 'lip', ball: i, x: hole.x, y: hole.y });
        } else {
          alive[i] = false;
          captures.push({ ball: i, hole, t });
          if (i === launched) launchedKind = 'hit';
          events.push({ t, type: 'hit', ball: i, x: x[i]!, y: y[i]! });
          break;
        }
      }
    }

    pushFrame();

    let settled = true;
    for (let i = 0; i < n; i++) if (alive[i] && !frozen[i]) settled = false;
    if (settled) return finish();
  }
  return finish();
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

export type BallStatus = 'resting' | 'rolling' | 'returning';

export interface BallView {
  id: number;
  x: number;
  y: number;
  status: BallStatus;
}

/** A roll in progress: everything needed to replay the same simulation. */
export interface FlightRecord {
  launch: Launch;
  atRest: BallAtRest[];
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
  balls: BallView[];
  flight: FlightRecord | null;
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
  /** Milliseconds until the current roll has settled (0 = pick a ball and roll). */
  cooldownMs: number;
  leaderProgress: number;
  playerCount: number;
  winnerId: string | null;
}

export type RollABallInput = { type: 'roll'; ball: number; x: number; y: number; vx: number; vy: number };

export function isRollInput(v: unknown): v is RollABallInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k]);
  return o.type === 'roll' && num('ball') && num('x') && num('y') && num('vx') && num('vy');
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
