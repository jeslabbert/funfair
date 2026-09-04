import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALLS_PER_PLAYER,
  BOARD,
  CHUTE_DELAY_TICKS,
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  HOLES,
  OBSTACLE_GRACE_TICKS,
  PHYSICS,
  ROWS,
  TRACK_LENGTH,
  WAVE_FADE_TICKS,
  WAVE_KINDS,
  WAVE_TICKS,
  clampLaunch,
  clampLaunchPosition,
  cloneTable,
  createTable,
  grabBall,
  launchBall,
  obstaclesAt,
  ordinal,
  sinA,
  stepTable,
  waveAt,
  tableBusy,
  tablesMatch,
  type TableEvent,
  type TableState,
} from './logic';
import { MAX_REWIND_TICKS, RollABallGame } from './server';
import type { PlayerInfo } from '@funfair/shared';

function player(id: string): PlayerInfo {
  return { id, name: id, color: '#fff', avatar: '🐎', connected: true, isVip: id === 'a' };
}

function makeGame(ids: string[]) {
  let clock = 0;
  const game = new RollABallGame({ players: ids.map(player), random: () => 0.5, now: () => clock });
  const advance = (ms: number) => {
    // Tick in 50 ms slices like the room does.
    while (ms > 0) {
      const step = Math.min(50, ms);
      clock += step;
      game.tick(step);
      ms -= step;
    }
  };
  return { game, advance };
}

/** Launch velocity for a power (0..1) and a lateral fraction of the speed. */
function velocity(power: number, lateral = 0) {
  const v = power * PHYSICS.maxLaunchSpeed;
  const vx = v * lateral;
  return { vx, vy: Math.sqrt(v * v - vx * vx) };
}

/** Step until nothing is rolling or waiting in the chute (or a tick budget runs out). */
function run(table: TableState, events: TableEvent[], maxTicks = 2400) {
  for (let i = 0; i < maxTicks && tableBusy(table); i++) stepTable(table, events);
}

/** Roll the middle ball from a point (default: centre of the bumper) on a fresh table. */
function roll(power: number, lateral = 0, from: { x: number; y: number } = { x: 0, y: BOARD.ballStartY }) {
  const table = createTable();
  const events: TableEvent[] = [];
  launchBall(table, { ball: 1, ...from, ...velocity(power, lateral) }, events);
  run(table, events);
  return { table, events, ball: table.balls.find((b) => b.id === 1)! };
}

const types = (events: TableEvent[], ball?: number) => events.filter((e) => ball === undefined || e.ball === ball).map((e) => e.type);
const hits = (events: TableEvent[], ball?: number) => events.filter((e) => e.type === 'hit' && (ball === undefined || e.ball === ball));
const settleOf = (events: TableEvent[], ball: number) => events.find((e) => e.type === 'settle' && e.ball === ball);

test('the pyramid has the right shape', () => {
  assert.equal(HOLES.length, (ROWS * (ROWS + 1)) / 2);
  const count = (z: string) => HOLES.filter((h) => h.zone === z).length;
  assert.equal(count('gallop'), 3);
  assert.equal(count('trot'), 7);
  assert.equal(count('walk'), 5);
  assert.ok(HOLES.every((h) => h.y > BOARD.rampLength && h.y < BOARD.gutterY));
  assert.equal(createTable().balls.length, BALLS_PER_PLAYER);
});

test('launch clamps: speed, angle and release point', () => {
  const fast = clampLaunch(0, 100);
  assert.ok(Math.abs(fast.vy - PHYSICS.maxLaunchSpeed) < 1e-9);
  const sideways = clampLaunch(10, 1);
  assert.ok(Math.abs(sideways.vx) <= PHYSICS.maxLateralRatio * Math.hypot(sideways.vx, sideways.vy) + 1e-9);
  assert.equal(clampLaunch(0, -5).vy, 0);
  const p = clampLaunchPosition(99, 99);
  assert.equal(p.x, BOARD.halfWidth - PHYSICS.ballRadius);
  assert.equal(p.y, BOARD.rampLength - PHYSICS.ballRadius);
  assert.deepEqual(clampLaunchPosition(NaN, -1), { x: 0, y: BOARD.ballStartY });
});

test('the table is deterministic and snapshots replay exactly', () => {
  const a = createTable();
  const b = createTable();
  launchBall(a, { ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.7, 0.2) });
  launchBall(b, { ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.7, 0.2) });
  const ea: TableEvent[] = [];
  const eb: TableEvent[] = [];
  for (let i = 0; i < 400; i++) {
    stepTable(a, ea);
    stepTable(b, eb);
    assert.ok(tablesMatch(a, b, 0));
  }
  assert.deepEqual(ea, eb);
  // A clone taken mid-flight continues identically.
  const c = cloneTable(a);
  for (let i = 0; i < 200; i++) {
    stepTable(a, ea);
    stepTable(c, eb);
  }
  assert.ok(tablesMatch(a, c, 0));
});

test('a roll that comes back bounces off the front bumper and settles where it lands', () => {
  let r = roll(0.6, 0.05);
  outer: for (let power = 0.55; power < 0.95; power += 0.02) {
    for (const lateral of [0, 0.05, 0.1, 0.15, 0.2]) {
      r = roll(power, lateral);
      const s = settleOf(r.events, 1);
      if (s?.crossedLip && hits(r.events).length === 0) break outer;
    }
  }
  const settle = settleOf(r.events, 1);
  assert.ok(settle?.crossedLip, 'the roll got onto the board and came back');
  const bumps = r.events.filter((e) => e.type === 'bumper' && e.ball === 1);
  assert.ok(bumps.length >= 2, `expected bumper bounces, got ${bumps.length}`);
  assert.equal(r.ball.status, 'resting');
  assert.ok(Math.abs(r.ball.y - BOARD.ballStartY) < 1e-6, 'came to rest on the bumper');
  assert.ok(Math.abs(r.ball.x) > 0.2, `drifted sideways to ${r.ball.x}, not re-centred`);
  for (const p of r.table.balls) for (const q of r.table.balls) if (p.id < q.id) assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= PHYSICS.ballRadius * 2 - 1e-3);
});

test('letting go on the ramp is a drop, not a roll', () => {
  const r = roll(0, 0, { x: 0.3, y: 2.5 });
  const settle = settleOf(r.events, 1);
  assert.ok(settle, 'it settled');
  assert.equal(settle!.crossedLip, false);
  assert.equal(r.ball.status, 'resting');
});

test('the right speed drops into the front row and the ball comes back through the chute', () => {
  const table = createTable();
  const events: TableEvent[] = [];
  launchBall(table, { ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55) }, events);
  for (let i = 0; i < 2400 && !hits(events).length; i++) stepTable(table, events);
  const hit = hits(events, 1)[0]!;
  const hole = HOLES[hit.hole!]!;
  assert.equal(hole.zone, 'walk');
  assert.equal(hole.row, 0);
  assert.equal(hole.col, 2);
  assert.ok(!types(events, 1).includes('skip'));
  const ball = table.balls.find((b) => b.id === 1)!;
  assert.equal(ball.status, 'returning');
  assert.equal(ball.returnsAt, hit.tick + CHUTE_DELAY_TICKS);
  run(table, events);
  const back = events.find((e) => e.type === 'return' && e.ball === 1)!;
  assert.equal(back.tick, hit.tick + CHUTE_DELAY_TICKS);
  assert.equal(ball.status, 'resting');
  assert.equal(ball.y, BOARD.ballStartY);
  for (const o of table.balls) if (o.id !== 1) assert.ok(Math.abs(o.x - ball.x) >= PHYSICS.ballRadius * 2);
});

test('the lip rejects a crawl; too fast skips', () => {
  let lipped = 0;
  for (let power = 0.4; power < 0.75; power += 0.01) {
    for (const lateral of [0, 0.1, 0.2]) {
      const r = roll(power, lateral);
      if (types(r.events, 1).includes('lip') && settleOf(r.events, 1)) lipped++;
    }
  }
  assert.ok(lipped > 0, 'no roll bounced off a lip');
  const quick = roll(0.65);
  assert.ok(types(quick.events, 1).includes('skip'), 'ball should skip the first hole');
  assert.equal(hits(quick.events, 1).length, 1);
});

test('a hard straight roll reaches the gallop triangle; a wide one bounces off the rail', () => {
  const gallop = roll(0.8);
  const hole = HOLES[hits(gallop.events, 1)[0]!.hole!]!;
  assert.equal(hole.zone, 'gallop');
  assert.equal(hole.row, ROWS - 1, 'a straight roll at this power reaches the apex');
  assert.ok(types(roll(1).events, 1).includes('gutter'));
  const bank = roll(0.75, 0.4);
  assert.ok(types(bank.events, 1).includes('rail'));
});

test('a returning ball knocks a resting one, and both settle apart', () => {
  const table = createTable();
  table.balls[0]!.x = 0.45;
  const events: TableEvent[] = [];
  launchBall(table, { ball: 1, x: 0, y: 2.0, vx: 0.8, vy: 0 }, events);
  run(table, events);
  assert.ok(types(events).includes('ball'), 'expected a ball-on-ball collision');
  const [p, q] = table.balls;
  assert.ok(Math.hypot(p!.x - q!.x, p!.y - q!.y) >= PHYSICS.ballRadius * 2 - 1e-3);
  assert.notEqual(p!.x, 0.45, 'the resting ball was moved');
  assert.ok(table.balls.every((b) => b.status === 'resting'));
});

test('two balls can be in flight at once', () => {
  const table = createTable();
  const events: TableEvent[] = [];
  launchBall(table, { ball: 0, x: -1.2, y: BOARD.ballStartY, ...velocity(0.55) }, events);
  for (let i = 0; i < 12; i++) stepTable(table, events);
  launchBall(table, { ball: 2, x: 1.2, y: BOARD.ballStartY, ...velocity(0.6, -0.05) }, events);
  assert.equal(table.balls.filter((b) => b.status === 'rolling').length, 2);
  run(table, events);
  for (const id of [0, 2]) assert.ok(hits(events, id).length + (settleOf(events, id) ? 1 : 0) >= 1, `ball ${id} finished its roll`);
});

test('a held ball takes no part in the physics', () => {
  const table = createTable();
  assert.ok(grabBall(table, 1));
  assert.equal(table.balls[1]!.status, 'held');
  assert.ok(!grabBall(table, 1));
  const events: TableEvent[] = [];
  launchBall(table, { ball: 0, x: 0, y: 2.0, vx: 0, vy: 0 }, events); // drops back through where ball 1 sits
  run(table, events);
  assert.ok(!types(events).includes('ball'));
  assert.ok(launchBall(table, { ball: 1, x: 0, y: 1, vx: 0, vy: 0 }));
});

test('obstacle waves follow the tick and the seed', () => {
  assert.equal(waveAt(0, 7), null);
  assert.equal(waveAt(OBSTACLE_GRACE_TICKS - 1, 7), null);
  for (const seed of [0, 1, 5, 12, 999]) {
    const kinds = new Set<string>();
    for (let i = 0; i < WAVE_KINDS.length; i++) kinds.add(waveAt(OBSTACLE_GRACE_TICKS + i * WAVE_TICKS + 100, seed)!.kind);
    assert.equal(kinds.size, WAVE_KINDS.length, `seed ${seed} shows every wave`);
  }
  const w = waveAt(OBSTACLE_GRACE_TICKS + 10, 3)!;
  assert.ok(w.alpha > 0 && w.alpha < 1, 'fading in');
  assert.equal(waveAt(OBSTACLE_GRACE_TICKS + WAVE_FADE_TICKS, 3)!.alpha, 1);
  assert.ok(!obstaclesAt(OBSTACLE_GRACE_TICKS + 10, 3).tangible);
  assert.ok(obstaclesAt(OBSTACLE_GRACE_TICKS + WAVE_FADE_TICKS, 3).tangible);
  // Deterministic and between the rails.
  for (let tick = OBSTACLE_GRACE_TICKS; tick < OBSTACLE_GRACE_TICKS + WAVE_TICKS * 4; tick += 37) {
    const a = obstaclesAt(tick, 42);
    const b = obstaclesAt(tick, 42);
    assert.deepEqual(a, b);
    for (const peg of a.pegs) assert.ok(Math.abs(peg.x) + peg.r <= BOARD.halfWidth);
  }
  // The arithmetic sine is close enough to the real one.
  for (let x = -7; x < 7; x += 0.13) assert.ok(Math.abs(sinA(x) - Math.sin(x)) < 0.002);
});

/** First tick at which a wave of this kind is fully in, for a seed. */
function waveStart(kind: string, seed: number): number {
  for (let i = 0; i < WAVE_KINDS.length; i++) {
    const tick = OBSTACLE_GRACE_TICKS + i * WAVE_TICKS;
    if (waveAt(tick, seed)!.kind === kind) return tick;
  }
  throw new Error('no such wave');
}

test('a sweeper post knocks a ball back', () => {
  const seed = 42;
  const table = createTable(seed);
  // Half-way through its sweep the post crosses the centre line.
  table.tick = waveStart('peg', seed) + 180 - 1;
  assert.ok(Math.abs(obstaclesAt(table.tick + 1, seed).pegs[0]!.x) < 0.05);
  const events: TableEvent[] = [];
  // Aim at where the post will be when the ball gets there.
  const meet = obstaclesAt(table.tick + 16, seed).pegs[0]!.x;
  launchBall(table, { ball: 1, x: meet, y: 4.7, vx: 0, vy: 12 }, events);
  for (let i = 0; i < 60; i++) stepTable(table, events);
  const bonk = events.find((e) => e.type === 'peg');
  assert.ok(bonk, 'ball hit the post');
  const ball = table.balls[1]!;
  assert.ok(ball.vy < 0, 'and is heading back down');
  assert.ok(ball.y < 6.1, 'from below it');
});

test('a lid over a hole makes the ball roll straight over it', () => {
  const seed = 42;
  const start = waveStart('lids', seed);
  // Walk holes are covered during the first two seconds of the wave.
  const table = createTable(seed);
  table.tick = start + WAVE_FADE_TICKS;
  const closed = obstaclesAt(table.tick + 1, seed).closed;
  assert.ok(closed.length === 5 && closed.every((i) => HOLES[i]!.zone === 'walk'));
  const events: TableEvent[] = [];
  launchBall(table, { ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55) }, events);
  let peak = 0;
  // Stay inside the two seconds the walk lids are down.
  for (let i = 0; i < 170; i++) {
    stepTable(table, events);
    peak = Math.max(peak, table.balls[1]!.y);
  }
  assert.ok(peak > HOLES[2]!.y - PHYSICS.captureRadius, 'the ball reached the covered hole');
  assert.ok(!events.some((e) => e.type === 'hit'), 'nothing caught it while covered');
  assert.ok(!events.some((e) => e.type === 'lip' || e.type === 'skip'), 'no lip either: it rolled straight over');
  // Without the lids the same roll is a walk.
  const plain = roll(0.55);
  assert.equal(HOLES[hits(plain.events, 1)[0]!.hole!]!.zone, 'walk');
});

test('ordinal', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});

test('rolls score when they land; balls can be rolled back to back', () => {
  const { game, advance } = makeGame(['a', 'b']);
  const tick = () => game.playerState('a').table.tick;
  game.onInput('a', { type: 'roll', ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55), tick: 0 });
  assert.equal(game.playerState('a').table.balls[1]!.status, 'resting', 'no rolling during the countdown');

  advance(COUNTDOWN_MS);
  assert.equal(game.hostState().phase, 'racing');
  game.onInput('a', { type: 'grab', ball: 1, tick: tick() });
  assert.equal(game.playerState('a').table.balls[1]!.status, 'held');
  game.onInput('a', { type: 'roll', ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55), tick: tick() });
  game.onInput('a', { type: 'roll', ball: 0, x: -1.2, y: BOARD.ballStartY, ...velocity(0.55), tick: tick() });
  let s = game.playerState('a');
  assert.equal(s.table.balls.filter((b) => b.status === 'rolling').length, 2, 'both balls rolling at once');
  assert.equal(s.me.progress, 0, 'no points until something drops in');

  advance(1500);
  s = game.playerState('a');
  assert.ok(s.me.progress >= 1, `scored ${s.me.progress}`);
  assert.ok(s.me.rolls >= 1);
  assert.equal(s.me.lastRoll?.kind, 'hit');
  assert.equal(game.playerState('b').leaderProgress, s.me.progress);
});

test('a late input is applied at the tick it happened', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS + 500);
  const now = game.playerState('a').table.tick;
  const late = now - 12;
  game.onInput('a', { type: 'roll', ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55), tick: late });
  // Reference: the same roll started at `late`, stepped up to `now`.
  const ref = createTable();
  ref.tick = late;
  launchBall(ref, { ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55) });
  const ev: TableEvent[] = [];
  while (ref.tick < now) stepTable(ref, ev);
  assert.ok(tablesMatch(game.playerState('a').table, ref, 0), 'server rewound and replayed the roll');
  assert.ok(MAX_REWIND_TICKS >= 12);
});

test('an input stamped a little ahead waits for its tick', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS + 500);
  const now = game.playerState('a').table.tick;
  const ahead = now + 6;
  game.onInput('a', { type: 'roll', ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55), tick: ahead });
  assert.equal(game.playerState('a').table.balls[1]!.status, 'resting', 'not applied yet');
  advance(200);
  const after = game.playerState('a').table;
  assert.equal(after.balls[1]!.status, 'rolling');
  const ref = createTable();
  ref.tick = ahead;
  launchBall(ref, { ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55) });
  const ev: TableEvent[] = [];
  while (ref.tick < after.tick) stepTable(ref, ev);
  assert.ok(tablesMatch(after, ref, 0), 'applied exactly at its tick');
});

test('a drop moves the ball but is not a roll', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS);
  game.onInput('a', { type: 'roll', ball: 0, x: -2.0, y: 1.5, vx: 0, vy: 0, tick: game.playerState('a').table.tick });
  advance(4000);
  const s = game.playerState('a');
  assert.equal(s.me.rolls, 0);
  assert.equal(game.hostState().feed.length, 0);
  const b = s.table.balls[0]!;
  assert.equal(b.status, 'resting');
  assert.ok(Math.abs(b.x - -2.0) < 0.3, `settled near where it was dropped, at ${b.x}`);
});

test('first racer to the line wins, then the game finishes after the linger', () => {
  const { game, advance } = makeGame(['a', 'b']);
  advance(COUNTDOWN_MS);
  const rollAny = (id: string, power: number) => {
    const s = game.playerState(id);
    const ball = s.table.balls.find((b) => b.status === 'resting');
    if (ball) game.onInput(id, { type: 'roll', ball: ball.id, x: 0, y: BOARD.ballStartY, ...velocity(power), tick: s.table.tick });
  };
  let rounds = 0;
  while (game.hostState().phase !== 'finished' && rounds < 60) {
    rollAny('a', 0.8);
    rollAny('b', 0.55);
    advance(1200);
    rounds++;
  }
  const host = game.hostState();
  assert.equal(host.phase, 'finished');
  assert.equal(host.winnerId, 'a');
  assert.equal(host.racers[0]!.progress, TRACK_LENGTH);
  assert.equal(game.isFinished(), false);
  advance(FINISH_LINGER_MS);
  assert.equal(game.isFinished(), true);
  const results = game.results();
  assert.deepEqual(results.standings.map((s) => s.playerId), ['a', 'b']);
  assert.match(results.standings[0]!.label, /1st/);
  assert.match(results.standings[1]!.label, /2nd/);
});

test('malformed input is rejected', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS);
  // @ts-expect-error deliberately malformed
  game.onInput('a', { type: 'roll', vx: 'lots' });
  // @ts-expect-error deliberately malformed
  game.onInput('a', null);
  game.onInput('a', { type: 'roll', ball: 7, x: 0, y: 0.3, vx: 0, vy: 5, tick: 0 });
  game.onInput('nobody', { type: 'roll', ball: 0, x: 0, y: 0.3, vx: 0, vy: 5, tick: 0 });
  assert.ok(game.playerState('a').table.balls.every((b) => b.status === 'resting'));
  assert.equal(game.playerState('a').me.rolls, 0);
});
