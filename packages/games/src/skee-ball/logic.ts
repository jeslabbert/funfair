/**
 * Pure rules for Skee-Ball Alley: a deterministic lockstep table, stepped at
 * a fixed rate on the phone and the server alike. Arithmetic and sqrt only.
 *
 * A ball rolls up the lane (which leans gently back towards the player), hits
 * the jump ramp at the end, flies, and lands on the tilted ring board. There it
 * keeps rolling: the board is a slope, the rings are raised cups with lips, and
 * the ball only scores once it drops into one – 20/30/40/50 in the rings, 100 in
 * the two top-corner pockets, or 10 when it rolls back down into the trough at
 * the foot of the board. Land too hard and it hops off the face once first.
 */

export const BALLS_PER_PLAYER = 9;
/** A round is over when everyone is out of balls or the clock runs out. */
export const ROUND_MS = 60_000;
export const COUNTDOWN_MS = 3000;
export const FINISH_LINGER_MS = 5000;

/** World units: y runs up the lane away from the player, z is height. */
export const LANE = {
  halfWidth: 2.6,
  ballStartY: 0.3,
  /** You can place a ball anywhere on the run-up, up to here. */
  placeMaxY: 4.5,
  /** The jump ramp starts here… */
  rampY: 8.0,
  /** …and launches the ball from here. */
  launchY: 8.8,
  /** The ring board's base and tilt (35° up from the floor). */
  boardBaseY: 11.6,
  boardCos: 0.8191520442889918,
  boardSin: 0.573576436351046,
  boardHalfWidth: 2.3,
  /** Height of the board along its face. */
  boardLength: 4.2,
  /** Ring centre along the board face. */
  ringU: 2.2,
  /** Corner pockets. */
  pocketU: 3.6,
  pocketX: 1.55,
  pocketR: 0.32,
} as const;

export const RINGS = [
  { points: 50, r: 0.34 },
  { points: 40, r: 0.7 },
  { points: 30, r: 1.1 },
  { points: 20, r: 1.55 },
] as const;

export const PHYSICS = {
  slope: 1.2,
  friction: 0.4,
  railRestitution: 0.55,
  bumperRestitution: 0.45,
  settleSpeed: 0.7,
  ballRestitution: 0.8,
  ballRadius: 0.3,
  maxLaunchSpeed: 14,
  maxLateralRatio: 0.45,
  /** Slower than this at the ramp and the ball just rolls back. */
  minJumpSpeed: 2.0,
  /** Launch angle: sin/cos of 52°. */
  jumpSin: 0.788010753606722,
  jumpCos: 0.6156614753256583,
  /** Speed kept over the ramp. */
  rampKeep: 0.85,
  gravity: 16,
  /** Faster than this into the board and the ball bounces before it lands. */
  hopSpeed: 3,
  hopRestitution: 0.4,
  hopTangentKeep: 0.75,
  wallRestitution: 0.5,
  /** Speed along the face kept when the ball lands and starts rolling. */
  landKeep: 0.6,
  /** Rolling on the board: friction on the face, and extra drag rattling around inside a cup. */
  faceFriction: 1.4,
  cupDrag: 0.8,
  /** Climbing a cup's lip from the face needs this much speed towards it… */
  lipSpeed: 1.0,
  /** …and climbing out of a cup needs this much. */
  escapeSpeed: 2.8,
  /** Faster than this over a lip and the ball skips the cup entirely. */
  skipSpeed: 4.2,
  /** Slower than this inside a cup and the ball drops in. */
  captureSpeed: 0.6,
  lipRestitution: 0.55,
  skipDamping: 0.82,
  boardWallRestitution: 0.5,
  stepMs: 1000 / 120,
} as const;

export type BallStatus = 'racked' | 'held' | 'rolling' | 'flying' | 'board' | 'resting' | 'done';

export interface BallState {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** While rolling on the board: position up the face, speed along it, and steps spent there. */
  u: number;
  vu: number;
  age: number;
  status: BallStatus;
  frozen: boolean;
  onBumper: boolean;
  hops: number;
  grace: number[];
  launchTick: number;
  /** Points once done (0 for a miss). */
  points: number;
}

export interface TableState {
  tick: number;
  balls: BallState[];
}

export type TableEventType =
  | 'launch'
  | 'jump'
  | 'hop'
  | 'land'
  | 'lip'
  | 'skip'
  | 'score'
  | 'miss'
  | 'rail'
  | 'wall'
  | 'bumper'
  | 'ball'
  | 'settle';

export interface TableEvent {
  tick: number;
  type: TableEventType;
  ball: number;
  x: number;
  y: number;
  z: number;
  /** For scores: points and where on the board (u along the face). For lips/skips: the cup's points. */
  points?: number;
  u?: number;
  /** For misses: why. */
  reason?: 'over';
}

export interface Launch {
  ball: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type SkeeBallInput =
  | { type: 'grab'; ball: number; tick: number }
  | { type: 'roll'; ball: number; x: number; y: number; vx: number; vy: number; tick: number };

export function isSkeeBallInput(v: unknown): v is SkeeBallInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k]);
  if (o.type === 'grab') return num('ball') && num('tick');
  if (o.type === 'roll') return num('ball') && num('x') && num('y') && num('vx') && num('vy') && num('tick');
  return false;
}

export const msToTick = (ms: number) => Math.floor(ms / PHYSICS.stepMs);

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clampLaunchPosition(x: number, y: number): { x: number; y: number } {
  const railX = LANE.halfWidth - PHYSICS.ballRadius;
  return {
    x: clamp(Number.isFinite(x) ? x : 0, -railX, railX),
    y: clamp(Number.isFinite(y) ? y : LANE.ballStartY, LANE.ballStartY, LANE.placeMaxY),
  };
}

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

/** A point on the board face, `u` up the face, in world (y, z). */
export function boardPoint(u: number): { y: number; z: number } {
  return { y: LANE.boardBaseY + u * LANE.boardCos, z: u * LANE.boardSin };
}

/** Where a ball centre sits relative to the board face: distance in front (+) and position along it. */
export function boardFrame(y: number, z: number): { d: number; u: number } {
  const dy = y - LANE.boardBaseY;
  return { d: -dy * LANE.boardSin + z * LANE.boardCos, u: dy * LANE.boardCos + z * LANE.boardSin };
}

/**
 * The cups on the face. A region is what the ball is over: -1 the plain face,
 * 0..3 the rings from the 50 outwards, 4/5 the left and right pockets.
 */
export interface Region {
  id: number;
  points: number;
  /** Centre of the cup, for its lip. */
  cx: number;
  cu: number;
}

export const FACE: Region = { id: -1, points: 10, cx: 0, cu: 0 };

export function regionAt(x: number, u: number): Region {
  for (let i = 0; i < 2; i++) {
    const cx = (i === 0 ? -1 : 1) * LANE.pocketX;
    const dx = x - cx;
    const du = u - LANE.pocketU;
    if (dx * dx + du * du <= LANE.pocketR * LANE.pocketR) return { id: 4 + i, points: 100, cx, cu: LANE.pocketU };
  }
  const du = u - LANE.ringU;
  const d = Math.sqrt(x * x + du * du);
  for (let i = 0; i < RINGS.length; i++) {
    const ring = RINGS[i]!;
    if (d <= ring.r) return { id: i, points: ring.points, cx: 0, cu: LANE.ringU };
  }
  return FACE;
}

/** Points for a spot on the board face: which cup it is over, 10 on the plain face, 0 off the board. */
export function scoreAt(x: number, u: number): number {
  if (u < 0 || u > LANE.boardLength || Math.abs(x) > LANE.boardHalfWidth) return 0;
  return regionAt(x, u).points;
}

function newBall(id: number): BallState {
  return { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, u: 0, vu: 0, age: 0, status: 'racked', frozen: true, onBumper: false, hops: 0, grace: [], launchTick: -1, points: 0 };
}

export function createTable(): TableState {
  return { tick: 0, balls: Array.from({ length: BALLS_PER_PLAYER }, (_, id) => newBall(id)) };
}

export function cloneTable(t: TableState): TableState {
  return { tick: t.tick, balls: t.balls.map((b) => ({ ...b, grace: [...b.grace] })) };
}

export function tablesMatch(a: TableState, b: TableState, eps = 1e-6): boolean {
  if (a.tick !== b.tick || a.balls.length !== b.balls.length) return false;
  for (let i = 0; i < a.balls.length; i++) {
    const p = a.balls[i]!;
    const q = b.balls[i]!;
    if (p.id !== q.id || p.status !== q.status || p.frozen !== q.frozen || p.points !== q.points) return false;
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'u', 'vu'] as const) if (Math.abs(p[k] - q[k]) > eps) return false;
  }
  return true;
}

/** Pick up a racked or resting ball. */
export function grabBall(t: TableState, ballId: number): boolean {
  const b = t.balls.find((k) => k.id === ballId);
  if (!b || (b.status !== 'racked' && b.status !== 'resting')) return false;
  b.status = 'held';
  b.vx = 0;
  b.vy = 0;
  b.vz = 0;
  b.z = 0;
  b.frozen = false;
  return true;
}

/** Roll a held (or racked / resting) ball from a point on the run-up. */
export function launchBall(t: TableState, launch: Launch, events?: TableEvent[]): boolean {
  const b = t.balls.find((k) => k.id === launch.ball);
  if (!b || (b.status !== 'held' && b.status !== 'racked' && b.status !== 'resting')) return false;
  const pos = clampLaunchPosition(launch.x, launch.y);
  const vel = clampLaunch(launch.vx, launch.vy);
  b.x = pos.x;
  b.y = pos.y;
  b.z = 0;
  b.vx = vel.vx;
  b.vy = vel.vy;
  b.vz = 0;
  b.status = 'rolling';
  b.frozen = false;
  b.onBumper = pos.y <= LANE.ballStartY + 1e-6;
  b.hops = 0;
  b.launchTick = t.tick;
  b.grace = t.balls
    .filter((o) => o.id !== b.id && (o.status === 'resting' || o.status === 'rolling') && Math.hypot(o.x - pos.x, o.y - pos.y) < PHYSICS.ballRadius * 2)
    .map((o) => o.id);
  events?.push({ tick: t.tick, type: 'launch', ball: b.id, x: b.x, y: b.y, z: 0 });
  return true;
}

export function ballsLeft(t: TableState): number {
  return t.balls.filter((b) => b.status !== 'done').length;
}

export function tableScore(t: TableState): number {
  return t.balls.reduce((sum, b) => sum + b.points, 0);
}

export function tableBusy(t: TableState): boolean {
  return t.balls.some((b) => b.status === 'rolling' || b.status === 'flying' || b.status === 'board');
}

/** Advance the table by one step. */
export function stepTable(t: TableState, events: TableEvent[]): void {
  const P = PHYSICS;
  const dt = P.stepMs / 1000;
  const railX = LANE.halfWidth - P.ballRadius;
  t.tick += 1;
  const tick = t.tick;
  const balls = t.balls;
  const onLane = (b: BallState) => b.status === 'resting' || b.status === 'rolling';

  for (const b of balls) {
    if (b.status === 'flying') {
      stepFlight(b, tick, dt, events);
      continue;
    }
    if (b.status === 'board') {
      stepBoard(b, tick, dt, events);
      continue;
    }
    if (!onLane(b) || b.frozen) continue;

    // Rolling on the lane: it leans back towards the player.
    let ax = 0;
    let ay = -P.slope;
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (speed > 1e-6) {
      ax -= (P.friction * b.vx) / speed;
      ay -= (P.friction * b.vy) / speed;
    }
    b.vx += ax * dt;
    b.vy += ay * dt;
    if (b.onBumper && b.vy < 0) b.vy = 0;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x > railX) {
      b.x = railX - (b.x - railX);
      b.vx = -Math.abs(b.vx) * P.railRestitution;
      events.push({ tick, type: 'rail', ball: b.id, x: b.x, y: b.y, z: 0 });
    } else if (b.x < -railX) {
      b.x = -railX + (-railX - b.x);
      b.vx = Math.abs(b.vx) * P.railRestitution;
      events.push({ tick, type: 'rail', ball: b.id, x: b.x, y: b.y, z: 0 });
    }

    // The jump ramp
    if (b.y >= LANE.rampY && b.vy > 0) {
      const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (v >= P.minJumpSpeed) {
        const kept = v * P.rampKeep;
        const lateral = b.vx / v;
        const forward = b.vy / v;
        const along = kept; // speed along the ramp's direction
        b.vx = lateral * along * P.jumpCos;
        b.vy = forward * along * P.jumpCos;
        b.vz = along * P.jumpSin;
        b.y = LANE.launchY;
        b.z = P.ballRadius;
        b.status = 'flying';
        events.push({ tick, type: 'jump', ball: b.id, x: b.x, y: b.y, z: b.z });
        continue;
      }
      // Too slow: the ramp turns it back.
      b.y = LANE.rampY;
      b.vy = -Math.abs(b.vy) * 0.3;
    }

    // Front bumper
    if (b.y < LANE.ballStartY && b.vy < 0) {
      b.y = LANE.ballStartY;
      if (-b.vy > P.settleSpeed) {
        b.vy = -b.vy * P.bumperRestitution;
        events.push({ tick, type: 'bumper', ball: b.id, x: b.x, y: b.y, z: 0 });
      } else {
        b.vy = 0;
        b.onBumper = true;
      }
    } else if (b.y > LANE.ballStartY + 0.02) {
      b.onBumper = false;
    }
    if (b.onBumper && Math.abs(b.vx) < P.settleSpeed && Math.abs(b.vy) < 1e-6) {
      b.vx = 0;
      b.frozen = true;
      if (b.status === 'rolling') {
        b.status = 'resting';
        events.push({ tick, type: 'settle', ball: b.id, x: b.x, y: b.y, z: 0 });
      }
    }
  }

  // Ball on ball, on the lane only
  for (let i = 0; i < balls.length; i++) {
    const p = balls[i]!;
    if (!onLane(p)) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const q = balls[j]!;
      if (!onLane(q)) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      const minD = P.ballRadius * 2;
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
        const k = ((1 + P.ballRestitution) / 2) * vn;
        p.vx += k * nx;
        p.vy += k * ny;
        q.vx -= k * nx;
        q.vy -= k * ny;
        events.push({ tick, type: 'ball', ball: q.id, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: 0 });
      }
      for (const b of [p, q]) {
        if (b.frozen) {
          b.frozen = false;
          if (b.status === 'resting') b.status = 'rolling';
        }
        if (b.y > LANE.ballStartY + 0.02) b.onBumper = false;
      }
    }
  }
}

function stepFlight(b: BallState, tick: number, dt: number, events: TableEvent[]): void {
  const P = PHYSICS;
  b.vz -= P.gravity * dt;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;

  // Side walls of the cabinet
  const wallX = LANE.halfWidth - P.ballRadius;
  if (b.x > wallX) {
    b.x = wallX - (b.x - wallX);
    b.vx = -Math.abs(b.vx) * P.wallRestitution;
    events.push({ tick, type: 'wall', ball: b.id, x: b.x, y: b.y, z: b.z });
  } else if (b.x < -wallX) {
    b.x = -wallX + (-wallX - b.x);
    b.vx = Math.abs(b.vx) * P.wallRestitution;
    events.push({ tick, type: 'wall', ball: b.id, x: b.x, y: b.y, z: b.z });
  }

  const top = boardPoint(LANE.boardLength);
  // Over the top of the board: gone into the net.
  if (b.y > top.y && b.z > top.z - P.ballRadius) return finish(b, tick, 0, events, 'over');

  const { d, u } = boardFrame(b.y, b.z);
  if (b.y >= LANE.boardBaseY - 0.6 && d <= P.ballRadius && u >= -0.3) {
    // Meeting the board face.
    const nY = -LANE.boardSin;
    const nZ = LANE.boardCos;
    const vn = b.vy * nY + b.vz * nZ; // < 0 when moving into the board
    if (vn < 0 && -vn > P.hopSpeed) {
      // Hard enough to bounce: hop off the face, then come down again a little lower.
      b.hops += 1;
      const tvx = b.vx * P.hopTangentKeep;
      const tvy = (b.vy - vn * nY) * P.hopTangentKeep;
      const tvz = (b.vz - vn * nZ) * P.hopTangentKeep;
      b.vx = tvx;
      b.vy = tvy - vn * nY * P.hopRestitution;
      b.vz = tvz - vn * nZ * P.hopRestitution;
      // Sit just off the face
      const back = P.ballRadius - d + 0.01;
      b.y += nY * back;
      b.z += nZ * back;
      events.push({ tick, type: 'hop', ball: b.id, x: b.x, y: b.y, z: b.z, u });
      return;
    }
    if (u > LANE.boardLength) return finish(b, tick, 0, events, 'over');
    // Landed: keep what was moving along the face and start rolling.
    b.status = 'board';
    b.age = 0;
    b.u = Math.max(0, u);
    b.vu = (b.vy * LANE.boardCos + b.vz * LANE.boardSin) * P.landKeep;
    b.vx *= P.landKeep;
    placeOnBoard(b);
    events.push({ tick, type: 'land', ball: b.id, x: b.x, y: b.y, z: b.z, u: b.u });
    return;
  }

  // Down on the floor: the whole pit between ramp and board drains into the 10 trough.
  if (b.z <= 0) return finish(b, tick, 10, events, undefined, 0);
}

/** World position of a ball sitting on the face at (x, u). */
function placeOnBoard(b: BallState): void {
  const R = PHYSICS.ballRadius;
  b.y = LANE.boardBaseY + b.u * LANE.boardCos - R * LANE.boardSin;
  b.z = b.u * LANE.boardSin + R * LANE.boardCos;
  b.vy = b.vu * LANE.boardCos;
  b.vz = b.vu * LANE.boardSin;
}

/**
 * Rolling on the board: a slope with raised cups. Gravity pulls the ball back
 * down the face; each cup has a lip that takes some speed to climb (more to
 * climb out), and a ball slow enough inside a cup drops in and scores it. Too
 * fast over a lip and it skips the cup. Off the foot of the board is the 10
 * trough; off the top is the net.
 */
function stepBoard(b: BallState, tick: number, dt: number, events: TableEvent[]): void {
  const P = PHYSICS;
  const before = regionAt(b.x, b.u);
  b.age += 1;

  b.vu -= P.gravity * LANE.boardSin * dt;
  const speed = Math.sqrt(b.vx * b.vx + b.vu * b.vu);
  if (speed > 1e-6) {
    const drag = (P.faceFriction + (before.id >= 0 ? P.cupDrag : 0)) * dt;
    const k = Math.max(0, 1 - drag / speed);
    b.vx *= k;
    b.vu *= k;
  }
  b.x += b.vx * dt;
  b.u += b.vu * dt;

  const wallX = LANE.boardHalfWidth - P.ballRadius;
  if (b.x > wallX) {
    b.x = wallX - (b.x - wallX);
    b.vx = -Math.abs(b.vx) * P.boardWallRestitution;
    events.push({ tick, type: 'wall', ball: b.id, x: b.x, y: b.y, z: b.z });
  } else if (b.x < -wallX) {
    b.x = -wallX + (-wallX - b.x);
    b.vx = Math.abs(b.vx) * P.boardWallRestitution;
    events.push({ tick, type: 'wall', ball: b.id, x: b.x, y: b.y, z: b.z });
  }

  if (b.u < 0) {
    b.u = 0;
    placeOnBoard(b);
    return finish(b, tick, 10, events, undefined, 0);
  }
  if (b.u > LANE.boardLength) {
    placeOnBoard(b);
    return finish(b, tick, 0, events, 'over');
  }

  const after = regionAt(b.x, b.u);
  if (after.id !== before.id) {
    // Crossing a lip: the cup being entered or left.
    const cup = after.id >= 0 ? after : before;
    const entering = before.id < 0 || (after.id >= 0 && after.id < before.id);
    let nx = b.x - cup.cx;
    let nu = b.u - cup.cu;
    const len = Math.sqrt(nx * nx + nu * nu) || 1;
    nx /= len;
    nu /= len;
    const vr = b.vx * nx + b.vu * nu; // outward speed
    const need = entering ? P.lipSpeed : P.escapeSpeed;
    if (Math.abs(vr) < need) {
      // Not enough to climb the lip: bounce off it, sitting just back on its own side.
      const lipR = cup.id >= 4 ? LANE.pocketR : RINGS[cup.id]!.r;
      const side = entering ? lipR + 0.01 : lipR - 0.01;
      b.x = cup.cx + nx * side;
      b.u = cup.cu + nu * side;
      b.vx -= (1 + P.lipRestitution) * vr * nx;
      b.vu -= (1 + P.lipRestitution) * vr * nu;
      placeOnBoard(b);
      events.push({ tick, type: 'lip', ball: b.id, x: b.x, y: b.y, z: b.z, u: b.u, points: cup.points });
      return;
    }
    if (after.id >= 0 && Math.abs(vr) < P.skipSpeed) {
      placeOnBoard(b);
      return finish(b, tick, after.points, events, undefined, b.u);
    }
    // Over it in one bound, losing a little speed.
    b.vx *= P.skipDamping;
    b.vu *= P.skipDamping;
    if (after.id >= 0) events.push({ tick, type: 'skip', ball: b.id, x: b.x, y: b.y, z: b.z, u: b.u, points: after.points });
  }

  placeOnBoard(b);
  if (after.id >= 0 && Math.sqrt(b.vx * b.vx + b.vu * b.vu) < P.captureSpeed) {
    return finish(b, tick, after.points, events, undefined, b.u);
  }
  // Wedged somewhere for ten seconds: the attendant knocks it in.
  if (b.age > 1200) return finish(b, tick, after.points, events, undefined, b.u);
}

function finish(b: BallState, tick: number, points: number, events: TableEvent[], reason?: 'over', u?: number): void {
  b.status = 'done';
  b.points = points;
  b.vx = 0;
  b.vy = 0;
  b.vz = 0;
  b.vu = 0;
  if (points > 0) events.push({ tick, type: 'score', ball: b.id, x: b.x, y: b.y, z: b.z, points, u });
  else events.push({ tick, type: 'miss', ball: b.id, x: b.x, y: b.y, z: b.z, reason });
}

export type Phase = 'countdown' | 'playing' | 'finished';

export interface Landing {
  x: number;
  /** Along the board face; -1 for a ball that went over. */
  u: number;
  points: number;
}

export interface RacerState {
  playerId: string;
  score: number;
  ballsLeft: number;
  landings: Landing[];
  lastScore: { points: number; at: number } | null;
  rank: number;
}

export interface FeedEntry {
  playerId: string;
  seq: number;
  points: number;
  at: number;
}

export interface SkeeBallHostState {
  phase: Phase;
  countdownMs: number;
  raceMs: number;
  roundMsLeft: number;
  racers: RacerState[];
  feed: FeedEntry[];
  winnerId: string | null;
}

export interface SkeeBallPlayerState {
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

/** The table as a lockstep simulation: one rules object for the server and the phone. */
export const tableRules = {
  stepMs: PHYSICS.stepMs,
  step: stepTable,
  clone: cloneTable,
  match: tablesMatch,
  apply(t: TableState, input: SkeeBallInput): void {
    if (input.type === 'grab') grabBall(t, input.ball);
    else launchBall(t, input);
  },
};

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
