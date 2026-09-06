/**
 * Pure rules for Hoops Shootout: a deterministic lockstep court, stepped at a
 * fixed rate on the phone and the server alike. Arithmetic and sqrt only.
 *
 * Each player has a rack of balls in front of a pop-a-shot cage. A flick
 * throws one at the hoop: plain ballistics, a rim it can bounce off, a
 * backboard to bank off, walls and a ceiling, and a net that catches a made
 * shot. Through the hoop is 2, untouched (a swish) is 3. Balls come back to
 * the rack a moment after they land, so keep them flying.
 */

export const BALLS_PER_PLAYER = 4;
export const ROUND_MS = 45_000;
export const COUNTDOWN_MS = 3000;
export const FINISH_LINGER_MS = 5000;
/** A ball comes back to the rack this long after it lands. */
export const RETURN_MS = 1200;

/** World units: y runs away from the player, z is up. */
export const COURT = {
  halfWidth: 2.3,
  /** Balls are thrown from here. */
  launchY: 0,
  launchZ: 1.1,
  launchMaxX: 1.6,
  /** Hoop centre. */
  hoopY: 6.2,
  hoopZ: 3.0,
  rimR: 0.72,
  rimTube: 0.04,
  /** Backboard plane and extents. */
  boardY: 6.75,
  boardHalfWidth: 1.5,
  boardBottom: 2.55,
  boardTop: 4.3,
  /** The cage: back wall and ceiling. */
  backY: 7.4,
  ceilingZ: 6.5,
  /** Net hangs this far below the rim. */
  netDepth: 0.85,
  /** Behind this line a ball is back with the player and gets returned. */
  outY: -0.6,
} as const;

export const PHYSICS = {
  gravity: 22,
  ballRadius: 0.4,
  maxLaunchSpeed: 16,
  maxLateralRatio: 0.35,
  /** Launch angle: sin/cos of 60°, a high arc that drops into the hoop. */
  launchSin: 0.8660254037844386,
  launchCos: 0.5,
  rimRestitution: 0.5,
  rimTangentKeep: 0.85,
  boardRestitution: 0.5,
  boardTangentKeep: 0.8,
  wallRestitution: 0.45,
  /** Speed kept passing through the net. */
  netKeep: 0.35,
  stepMs: 1000 / 120,
} as const;

export type BallStatus = 'racked' | 'held' | 'flying' | 'done' | 'returning';

export interface BallState {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  status: BallStatus;
  /** What it has touched since launch: 1 = rim, 2 = backboard, 4 = wall. */
  touched: number;
  /** Whether it went through the hoop on this flight. */
  made: boolean;
  launchTick: number;
  doneTick: number;
  /** Points once done (0 for a miss). */
  points: number;
}

export interface TableState {
  tick: number;
  balls: BallState[];
}

export type TableEventType = 'launch' | 'rim' | 'board' | 'wall' | 'score' | 'miss' | 'return';

export interface TableEvent {
  tick: number;
  type: TableEventType;
  ball: number;
  x: number;
  y: number;
  z: number;
  /** For scores: points; swish when true. */
  points?: number;
  swish?: boolean;
}

export interface Shot {
  ball: number;
  x: number;
  vx: number;
  vy: number;
}

export type HoopsInput =
  | { type: 'grab'; ball: number; tick: number }
  | { type: 'shoot'; ball: number; x: number; vx: number; vy: number; tick: number };

export function isHoopsInput(v: unknown): v is HoopsInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k]);
  if (o.type === 'grab') return num('ball') && num('tick');
  if (o.type === 'shoot') return num('ball') && num('x') && num('vx') && num('vy') && num('tick');
  return false;
}

export const msToTick = (ms: number) => Math.floor(ms / PHYSICS.stepMs);
export const RETURN_TICKS = msToTick(RETURN_MS);

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clampLaunchX(x: number): number {
  return clamp(Number.isFinite(x) ? x : 0, -COURT.launchMaxX, COURT.launchMaxX);
}

/** Clamp a flick to the launch envelope: forward speed and a limited sideways share. */
export function clampLaunch(vx: number, vy: number): { vx: number; vy: number } {
  let y = Math.max(0, vy);
  let x = vx;
  const speed = Math.sqrt(x * x + y * y);
  if (speed > PHYSICS.maxLaunchSpeed) {
    const k = PHYSICS.maxLaunchSpeed / speed;
    x *= k;
    y *= k;
  }
  const s = Math.sqrt(x * x + y * y);
  if (s > 0 && Math.abs(x) > PHYSICS.maxLateralRatio * s) {
    const r = PHYSICS.maxLateralRatio;
    x = (x < 0 ? -r : r) * s;
    y = Math.sqrt(1 - r * r) * s;
  }
  return { vx: x, vy: y };
}

function newBall(id: number): BallState {
  return { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, status: 'racked', touched: 0, made: false, launchTick: -1, doneTick: -1, points: 0 };
}

export function createTable(): TableState {
  return { tick: 0, balls: Array.from({ length: BALLS_PER_PLAYER }, (_, id) => newBall(id)) };
}

export function cloneTable(t: TableState): TableState {
  return { tick: t.tick, balls: t.balls.map((b) => ({ ...b })) };
}

export function tablesMatch(a: TableState, b: TableState, eps = 1e-6): boolean {
  if (a.tick !== b.tick || a.balls.length !== b.balls.length) return false;
  for (let i = 0; i < a.balls.length; i++) {
    const p = a.balls[i]!;
    const q = b.balls[i]!;
    if (p.id !== q.id || p.status !== q.status || p.points !== q.points || p.touched !== q.touched || p.made !== q.made) return false;
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const) if (Math.abs(p[k] - q[k]) > eps) return false;
  }
  return true;
}

/** Pick up a racked ball. */
export function grabBall(t: TableState, ballId: number): boolean {
  const b = t.balls.find((k) => k.id === ballId);
  if (!b || b.status !== 'racked') return false;
  b.status = 'held';
  return true;
}

/** Throw a held (or racked) ball from a point along the rack. */
export function shootBall(t: TableState, shot: Shot, events?: TableEvent[]): boolean {
  const b = t.balls.find((k) => k.id === shot.ball);
  if (!b || (b.status !== 'held' && b.status !== 'racked')) return false;
  const vel = clampLaunch(shot.vx, shot.vy);
  b.x = clampLaunchX(shot.x);
  b.y = COURT.launchY;
  b.z = COURT.launchZ;
  b.vx = vel.vx;
  b.vy = vel.vy * PHYSICS.launchCos;
  b.vz = vel.vy * PHYSICS.launchSin;
  b.status = 'flying';
  b.touched = 0;
  b.made = false;
  b.points = 0;
  b.launchTick = t.tick;
  events?.push({ tick: t.tick, type: 'launch', ball: b.id, x: b.x, y: b.y, z: b.z });
  return true;
}

export function ballsReady(t: TableState): number {
  return t.balls.filter((b) => b.status === 'racked').length;
}

export function tableBusy(t: TableState): boolean {
  return t.balls.some((b) => b.status === 'flying');
}

/** Advance the court by one step. */
export function stepTable(t: TableState, events: TableEvent[]): void {
  const P = PHYSICS;
  const C = COURT;
  const dt = P.stepMs / 1000;
  const R = P.ballRadius;
  t.tick += 1;
  const tick = t.tick;

  for (const b of t.balls) {
    if (b.status === 'done') {
      if (tick - b.doneTick >= RETURN_TICKS) {
        b.status = 'racked';
        b.x = 0;
        b.y = 0;
        b.z = 0;
        b.vx = b.vy = b.vz = 0;
        events.push({ tick, type: 'return', ball: b.id, x: 0, y: 0, z: 0 });
      }
      continue;
    }
    if (b.status !== 'flying') continue;

    const z0 = b.z;
    const inside0 = Math.sqrt(b.x * b.x + (b.y - C.hoopY) * (b.y - C.hoopY)) < C.rimR;
    b.vz -= P.gravity * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    // Through the hoop: crossing the rim plane downwards with the centre inside the ring
    if (!b.made && z0 >= C.hoopZ && b.z < C.hoopZ) {
      const d = Math.sqrt(b.x * b.x + (b.y - C.hoopY) * (b.y - C.hoopY));
      if (d < C.rimR - R * 0.35 && inside0) {
        b.made = true;
        const swish = b.touched === 0;
        b.points = swish ? 3 : 2;
        // The net grabs it
        b.vx *= P.netKeep;
        b.vy *= P.netKeep;
        b.vz *= P.netKeep;
        events.push({ tick, type: 'score', ball: b.id, x: b.x, y: b.y, z: b.z, points: b.points, swish });
      }
    }

    // Rim: a ring of tube around the hoop circle
    if (!b.made || b.z > C.hoopZ - 0.2) {
      const dx = b.x;
      const dy = b.y - C.hoopY;
      const dh = Math.sqrt(dx * dx + dy * dy);
      const px = dh > 1e-6 ? (dx / dh) * C.rimR : C.rimR;
      const py = dh > 1e-6 ? (dy / dh) * C.rimR : 0;
      let nx = b.x - px;
      let ny = b.y - C.hoopY - py;
      let nz = b.z - C.hoopZ;
      const dist = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const minD = R + C.rimTube;
      if (dist < minD && dist > 1e-6) {
        nx /= dist;
        ny /= dist;
        nz /= dist;
        const vn = b.vx * nx + b.vy * ny + b.vz * nz;
        if (vn < 0) {
          const tx = b.vx - vn * nx;
          const ty = b.vy - vn * ny;
          const tz = b.vz - vn * nz;
          b.vx = tx * P.rimTangentKeep - vn * nx * P.rimRestitution;
          b.vy = ty * P.rimTangentKeep - vn * ny * P.rimRestitution;
          b.vz = tz * P.rimTangentKeep - vn * nz * P.rimRestitution;
          b.touched |= 1;
          events.push({ tick, type: 'rim', ball: b.id, x: b.x, y: b.y, z: b.z });
          // A ball balancing on the rim tips inward rather than sitting there forever.
          const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
          if (speed < 1.0) {
            b.vx -= (px / C.rimR) * 0.25;
            b.vy -= (py / C.rimR) * 0.25;
          }
        }
        const push = minD - dist;
        b.x += nx * push;
        b.y += ny * push;
        b.z += nz * push;
      }
    }

    // Backboard: a vertical plane facing the player
    if (b.y + R > C.boardY && b.vy > 0 && Math.abs(b.x) < C.boardHalfWidth + R && b.z > C.boardBottom - R && b.z < C.boardTop + R) {
      b.y = C.boardY - R;
      b.vy = -b.vy * P.boardRestitution;
      b.vx *= P.boardTangentKeep;
      b.vz *= P.boardTangentKeep;
      b.touched |= 2;
      events.push({ tick, type: 'board', ball: b.id, x: b.x, y: b.y, z: b.z });
    }

    // The cage: side walls, back wall, ceiling
    const wallX = C.halfWidth - R;
    if (b.x > wallX) {
      b.x = wallX - (b.x - wallX);
      b.vx = -Math.abs(b.vx) * P.wallRestitution;
      b.touched |= 4;
      events.push({ tick, type: 'wall', ball: b.id, x: b.x, y: b.y, z: b.z });
    } else if (b.x < -wallX) {
      b.x = -wallX + (-wallX - b.x);
      b.vx = Math.abs(b.vx) * P.wallRestitution;
      b.touched |= 4;
      events.push({ tick, type: 'wall', ball: b.id, x: b.x, y: b.y, z: b.z });
    }
    if (b.y + R > C.backY && b.vy > 0) {
      b.y = C.backY - R;
      b.vy = -b.vy * P.wallRestitution;
      b.touched |= 4;
      events.push({ tick, type: 'wall', ball: b.id, x: b.x, y: b.y, z: b.z });
    }
    if (b.z + R > C.ceilingZ && b.vz > 0) {
      b.z = C.ceilingZ - R;
      b.vz = -b.vz * P.wallRestitution;
      b.touched |= 4;
    }

    // Down on the floor, or back past the player: the shot is over
    if (b.z - R <= 0 || b.y < C.outY) {
      b.z = Math.max(b.z, R);
      b.status = 'done';
      b.doneTick = tick;
      b.vx = b.vy = b.vz = 0;
      if (!b.made) events.push({ tick, type: 'miss', ball: b.id, x: b.x, y: b.y, z: b.z });
    }
  }
}

export type Phase = 'countdown' | 'playing' | 'finished';

export interface ShotRecord {
  x: number;
  y: number;
  points: number;
}

export interface RacerState {
  playerId: string;
  score: number;
  attempts: number;
  makes: number;
  streak: number;
  bestStreak: number;
  shots: ShotRecord[];
  lastScore: { points: number; at: number } | null;
  rank: number;
}

export interface FeedEntry {
  playerId: string;
  seq: number;
  points: number;
  swish: boolean;
  at: number;
}

export interface HoopsHostState {
  phase: Phase;
  countdownMs: number;
  raceMs: number;
  roundMsLeft: number;
  racers: RacerState[];
  feed: FeedEntry[];
  winnerId: string | null;
}

export interface HoopsPlayerState {
  phase: Phase;
  countdownMs: number;
  raceMs: number;
  roundMsLeft: number;
  me: RacerState;
  table: TableState;
  leaderScore: number;
  playerCount: number;
  winnerId: string | null;
}

/** The court as a lockstep simulation: one rules object for the server and the phone. */
export const tableRules = {
  stepMs: PHYSICS.stepMs,
  step: stepTable,
  clone: cloneTable,
  match: tablesMatch,
  apply(t: TableState, input: HoopsInput): void {
    if (input.type === 'grab') grabBall(t, input.ball);
    else shootBall(t, input);
  },
};

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
