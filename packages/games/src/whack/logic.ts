/**
 * Pure rules for Mole Mayhem: a deterministic lockstep field, stepped at a
 * fixed rate on the phone and the server alike. Arithmetic and sqrt only.
 *
 * Moles pop out of a grid of holes and duck back down a moment later. Instead
 * of tapping them you cut across the field: every stroke of the finger is a
 * short segment, and any mole the segment passes through is whacked. Hits
 * close together chain into a combo worth more each time. Bombs come up too,
 * and cutting one costs points and stuns you for a beat.
 */

export const ROUND_MS = 45_000;
export const COUNTDOWN_MS = 3000;
export const FINISH_LINGER_MS = 5000;

/** The field: a grid of holes the moles come out of. */
export const FIELD = {
  cols: 3,
  rows: 3,
  /** Spacing between hole centres. */
  gapX: 2.0,
  gapY: 2.0,
  /** The front row sits here, rows go away from the player. */
  frontY: 0.6,
  holeR: 0.72,
} as const;

export const MOLE = {
  r: 0.55,
  /** How far below the ground a mole starts, and how far above it rises. */
  depth: 1.1,
  up: 0.38,
  /** Ticks to rise, to stay up, and to duck back down. */
  riseTicks: 26,
  duckTicks: 26,
  /** Above this height a mole can be cut. */
  hitZ: -0.15,
  /** Blade thickness: how close the stroke must pass. */
  bladeR: 0.28,
} as const;

export const RULES = {
  /** A spawn beat every this many ticks; the field gets busier as the round goes on. */
  beatTicks: 44,
  /** Chances of a second and third mole on one beat, early and late in the round. */
  extraEarly: 0.22,
  extraLate: 0.62,
  /** Chance a mole is a bomb, and a golden one. */
  bombChance: 0.16,
  goldChance: 0.12,
  /** Hits within this many ticks chain the combo. */
  comboTicks: 90,
  maxCombo: 5,
  /** Cutting a bomb: the penalty, and how long the blade is dead afterwards. */
  bombPenalty: 3,
  stunTicks: 96,
  /** Points. */
  molePoints: 1,
  goldPoints: 3,
  stepMs: 1000 / 120,
} as const;

/** How long each kind stays up, in ticks. */
export const LIFE_TICKS = { mole: 150, gold: 96, bomb: 168 } as const;

export type MoleKind = 'mole' | 'gold' | 'bomb';
export type MoleStatus = 'active' | 'hit' | 'gone';

export interface MoleState {
  id: number;
  hole: number;
  kind: MoleKind;
  spawnTick: number;
  lifeTicks: number;
  status: MoleStatus;
  /** Height above the ground: negative while still in the hole. */
  z: number;
  /** While flying off after a hit. */
  vz: number;
  vx: number;
  spin: number;
  points: number;
  hitTick: number;
}

export interface TableState {
  tick: number;
  seed: number;
  nextId: number;
  combo: number;
  lastHitTick: number;
  stunUntilTick: number;
  moles: MoleState[];
}

export type TableEventType = 'spawn' | 'whack' | 'bomb' | 'escape' | 'stun';

export interface TableEvent {
  tick: number;
  type: TableEventType;
  mole: number;
  hole: number;
  x: number;
  y: number;
  kind: MoleKind;
  points?: number;
  combo?: number;
}

export type WhackInput = { type: 'slice'; x0: number; y0: number; x1: number; y1: number; tick: number };

export function isWhackInput(v: unknown): v is WhackInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.type !== 'slice') return false;
  return (['x0', 'y0', 'x1', 'y1', 'tick'] as const).every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
}

export const msToTick = (ms: number) => Math.floor(ms / RULES.stepMs);

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A deterministic 32-bit hash of two integers: the same everywhere, no floating point. */
export function hash32(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ b, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in [0, 1) from a seed and a counter. */
export const rand01 = (a: number, b: number) => hash32(a, b) / 4294967296;

export const holeCount = FIELD.cols * FIELD.rows;

/** Where a hole sits on the field. */
export function holePos(hole: number): { x: number; y: number } {
  const col = hole % FIELD.cols;
  const row = Math.floor(hole / FIELD.cols);
  return { x: (col - (FIELD.cols - 1) / 2) * FIELD.gapX, y: FIELD.frontY + row * FIELD.gapY };
}

export function createTable(seed = 1): TableState {
  return { tick: 0, seed: seed >>> 0 || 1, nextId: 1, combo: 0, lastHitTick: -9999, stunUntilTick: 0, moles: [] };
}

export function cloneTable(t: TableState): TableState {
  return { ...t, moles: t.moles.map((m) => ({ ...m })) };
}

export function tablesMatch(a: TableState, b: TableState, eps = 1e-6): boolean {
  if (a.tick !== b.tick || a.moles.length !== b.moles.length) return false;
  if (a.combo !== b.combo || a.stunUntilTick !== b.stunUntilTick || a.nextId !== b.nextId) return false;
  for (let i = 0; i < a.moles.length; i++) {
    const p = a.moles[i]!;
    const q = b.moles[i]!;
    if (p.id !== q.id || p.status !== q.status || p.kind !== q.kind || p.hole !== q.hole || p.points !== q.points) return false;
    if (Math.abs(p.z - q.z) > eps) return false;
  }
  return true;
}

/** Height of a mole above the ground for its age, in ticks. */
export function moleHeight(age: number, lifeTicks: number): number {
  const total = MOLE.depth + MOLE.up;
  if (age < MOLE.riseTicks) return -MOLE.depth + total * (age / MOLE.riseTicks);
  const duckStart = lifeTicks - MOLE.duckTicks;
  if (age >= duckStart) return -MOLE.depth + total * clamp((lifeTicks - age) / MOLE.duckTicks, 0, 1);
  return MOLE.up;
}

export const isUp = (m: MoleState) => m.status === 'active' && m.z >= MOLE.hitZ;

export function stunned(t: TableState): boolean {
  return t.tick < t.stunUntilTick;
}

/** Distance from a point to a segment. */
export function pointSegmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 1e-9) t = clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1);
  const cx = x0 + dx * t;
  const cy = y0 + dy * t;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

/** Cut across the field: everything the stroke passes through gets whacked. */
export function slice(t: TableState, input: WhackInput, events?: TableEvent[]): void {
  if (stunned(t)) return;
  const reach = MOLE.r + MOLE.bladeR;
  for (const m of t.moles) {
    if (!isUp(m)) continue;
    const p = holePos(m.hole);
    if (pointSegmentDistance(p.x, p.y, input.x0, input.y0, input.x1, input.y1) > reach) continue;
    m.status = 'hit';
    m.hitTick = t.tick;
    m.vz = 7;
    m.vx = input.x1 - input.x0 > 0 ? 2.4 : -2.4;
    m.spin = 12;
    if (m.kind === 'bomb') {
      m.points = -RULES.bombPenalty;
      t.combo = 0;
      t.stunUntilTick = t.tick + RULES.stunTicks;
      events?.push({ tick: t.tick, type: 'bomb', mole: m.id, hole: m.hole, x: p.x, y: p.y, kind: m.kind, points: m.points });
      events?.push({ tick: t.tick, type: 'stun', mole: m.id, hole: m.hole, x: p.x, y: p.y, kind: m.kind });
      return;
    }
    t.combo = t.tick - t.lastHitTick <= RULES.comboTicks ? Math.min(RULES.maxCombo, t.combo + 1) : 1;
    t.lastHitTick = t.tick;
    const base = m.kind === 'gold' ? RULES.goldPoints : RULES.molePoints;
    m.points = base * t.combo;
    events?.push({ tick: t.tick, type: 'whack', mole: m.id, hole: m.hole, x: p.x, y: p.y, kind: m.kind, points: m.points, combo: t.combo });
  }
}

/** Which kind comes up next, from the seed and the beat. */
function pickKind(seed: number, beat: number, slot: number): MoleKind {
  const r = rand01(seed ^ 0x5bf03635, beat * 7 + slot * 131);
  if (r < RULES.bombChance) return 'bomb';
  if (r < RULES.bombChance + RULES.goldChance) return 'gold';
  return 'mole';
}

function spawn(t: TableState, hole: number, kind: MoleKind, events: TableEvent[]): void {
  const p = holePos(hole);
  t.moles.push({
    id: t.nextId++,
    hole,
    kind,
    spawnTick: t.tick,
    lifeTicks: LIFE_TICKS[kind],
    status: 'active',
    z: -MOLE.depth,
    vz: 0,
    vx: 0,
    spin: 0,
    points: 0,
    hitTick: -1,
  });
  events.push({ tick: t.tick, type: 'spawn', mole: t.nextId - 1, hole, x: p.x, y: p.y, kind });
}

/** Advance the field by one step. */
export function stepTable(t: TableState, events: TableEvent[]): void {
  const dt = RULES.stepMs / 1000;
  t.tick += 1;
  const tick = t.tick;

  // Spawn beat
  if (tick % RULES.beatTicks === 0) {
    const beat = tick / RULES.beatTicks;
    const busy = new Set(t.moles.filter((m) => m.status === 'active').map((m) => m.hole));
    // The field fills up as the round goes on.
    const progress = clamp(beat / 60, 0, 1);
    const extra = RULES.extraEarly + (RULES.extraLate - RULES.extraEarly) * progress;
    let want = 1;
    if (rand01(t.seed, beat * 3 + 1) < extra) want += 1;
    if (rand01(t.seed, beat * 3 + 2) < extra * 0.45) want += 1;
    for (let slot = 0; slot < want; slot++) {
      const free: number[] = [];
      for (let h = 0; h < holeCount; h++) if (!busy.has(h)) free.push(h);
      if (!free.length) break;
      const pick = free[Math.floor(rand01(t.seed ^ 0x1f123bb5, beat * 17 + slot) * free.length) % free.length]!;
      busy.add(pick);
      spawn(t, pick, pickKind(t.seed, beat, slot), events);
    }
  }

  for (const m of t.moles) {
    if (m.status === 'active') {
      const age = tick - m.spawnTick;
      m.z = moleHeight(age, m.lifeTicks);
      if (age >= m.lifeTicks) {
        m.status = 'gone';
        const p = holePos(m.hole);
        // Only a mole that actually showed itself counts as one that got away.
        if (m.kind !== 'bomb') events.push({ tick, type: 'escape', mole: m.id, hole: m.hole, x: p.x, y: p.y, kind: m.kind });
      }
      continue;
    }
    if (m.status === 'hit') {
      m.vz -= 20 * dt;
      m.z += m.vz * dt;
      if (m.z < -MOLE.depth * 2) m.status = 'gone';
    }
  }
  // Forget moles that are done with, oldest first, so the state stays small.
  if (t.moles.length > 24) t.moles = t.moles.filter((m) => m.status !== 'gone' || tick - m.spawnTick < 240);
}

export function activeMoles(t: TableState): MoleState[] {
  return t.moles.filter((m) => m.status === 'active');
}

export type Phase = 'countdown' | 'playing' | 'finished';

export interface RacerState {
  playerId: string;
  score: number;
  whacked: number;
  missed: number;
  bombs: number;
  combo: number;
  bestCombo: number;
  /** Holes hit recently, newest last, for the host's field. */
  recent: number[];
  lastScore: { points: number; at: number } | null;
  rank: number;
}

export interface FeedEntry {
  playerId: string;
  seq: number;
  points: number;
  kind: MoleKind;
  combo: number;
  at: number;
}

export interface WhackHostState {
  phase: Phase;
  countdownMs: number;
  raceMs: number;
  roundMsLeft: number;
  racers: RacerState[];
  feed: FeedEntry[];
  winnerId: string | null;
}

export interface WhackPlayerState {
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

/** The field as a lockstep simulation: one rules object for the server and the phone. */
export const tableRules = {
  stepMs: RULES.stepMs,
  step: stepTable,
  clone: cloneTable,
  match: tablesMatch,
  apply(t: TableState, input: WhackInput, events: TableEvent[]): void {
    slice(t, input, events);
  },
};

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
