import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALLS_PER_PLAYER,
  BALL_START_XS,
  BOARD,
  CHUTE_DELAY_MS,
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  HOLES,
  PHYSICS,
  ROWS,
  TRACK_LENGTH,
  clampLaunch,
  clampLaunchPosition,
  ordinal,
  simulateRoll,
  type BallAtRest,
  type Launch,
} from './logic';
import { RollABallGame } from './server';
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

/** The table at the start of a game. */
const startTable = (): BallAtRest[] => BALL_START_XS.map((x, id) => ({ id, x, y: BOARD.ballStartY }));

/** Launch velocity for a power (0..1) and a lateral fraction of the speed. */
function velocity(power: number, lateral = 0) {
  const v = power * PHYSICS.maxLaunchSpeed;
  const vx = v * lateral;
  return { vx, vy: Math.sqrt(v * v - vx * vx) };
}

/** Roll the middle ball from the centre of the bumper. */
function roll(power: number, lateral = 0, from: { x: number; y: number } = { x: 0, y: BOARD.ballStartY }) {
  const launch: Launch = { ball: 1, ...from, ...velocity(power, lateral) };
  return simulateRoll(launch, startTable());
}

const types = (events: { type: string; ball: number }[], ball?: number) => events.filter((e) => ball === undefined || e.ball === ball).map((e) => e.type);

test('the pyramid has the right shape', () => {
  assert.equal(HOLES.length, (ROWS * (ROWS + 1)) / 2);
  const count = (z: string) => HOLES.filter((h) => h.zone === z).length;
  assert.equal(count('gallop'), 3);
  assert.equal(count('trot'), 7);
  assert.equal(count('walk'), 5);
  assert.ok(HOLES.every((h) => h.y > BOARD.rampLength && h.y < BOARD.gutterY));
  assert.equal(BALL_START_XS.length, BALLS_PER_PLAYER);
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

test('simulateRoll is deterministic', () => {
  const a = roll(0.7, 0.2);
  const b = roll(0.7, 0.2);
  assert.deepEqual(a.outcome, b.outcome);
  assert.deepEqual(a.frames, b.frames);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.final, b.final);
});

test('a roll that comes back bounces off the front bumper and settles where it lands', () => {
  // Find a roll that gets onto the board and comes back without dropping in.
  let sim = roll(0.6, 0.05);
  outer: for (let power = 0.55; power < 0.95; power += 0.02) {
    for (const lateral of [0, 0.05, 0.1, 0.15, 0.2]) {
      sim = roll(power, lateral);
      if (sim.outcome.kind === 'back' && sim.outcome.peakY > BOARD.rampLength) break outer;
    }
  }
  assert.equal(sim.outcome.kind, 'back');
  assert.equal(sim.outcome.points, 0);
  assert.ok(sim.outcome.peakY > BOARD.rampLength, 'it got onto the board');
  const bumps = sim.events.filter((e) => e.type === 'bumper' && e.ball === sim.launched);
  assert.ok(bumps.length >= 2, `expected bumper bounces, got ${bumps.length}`);
  assert.equal(sim.final.length, 3, 'all three balls still on the table');
  const me = sim.final.find((b) => b.id === 1)!;
  assert.ok(Math.abs(me.y - BOARD.ballStartY) < 1e-6, 'came to rest on the bumper');
  assert.ok(Math.abs(me.x) > 0.2, `drifted sideways to ${me.x}, not re-centred`);
  // Nobody overlaps at rest.
  for (const p of sim.final) for (const q of sim.final) if (p.id < q.id) assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= PHYSICS.ballRadius * 2 - 1e-3);
});

test('letting go on the ramp is a drop, not a roll', () => {
  const sim = simulateRoll({ ball: 1, x: 0.3, y: 2.5, vx: 0, vy: 0 }, startTable());
  assert.equal(sim.outcome.kind, 'back');
  assert.ok(sim.outcome.peakY < BOARD.rampLength);
  assert.ok(sim.outcome.endedAt > 0);
});

test('the right speed drops into the front row; the lip rejects a crawl; too fast skips', () => {
  const walk = roll(0.55);
  assert.equal(walk.outcome.kind, 'hit');
  assert.equal(walk.outcome.zone, 'walk');
  assert.equal(walk.outcome.row, 0);
  assert.equal(walk.outcome.col, 2);
  assert.ok(!types(walk.events, walk.launched).includes('skip'));
  assert.equal(walk.final.length, 2, 'the rolled ball is off the table');

  let lipped = 0;
  for (let power = 0.4; power < 0.75; power += 0.01) {
    for (const lateral of [0, 0.1, 0.2]) {
      const sim = roll(power, lateral);
      if (types(sim.events, sim.launched).includes('lip') && sim.outcome.kind === 'back') lipped++;
    }
  }
  assert.ok(lipped > 0, 'no roll bounced off a lip');

  const quick = roll(0.65);
  assert.ok(types(quick.events, quick.launched).includes('skip'), 'ball should skip the first hole');
  assert.equal(quick.outcome.kind, 'hit');
});

test('a hard straight roll reaches the gallop triangle; a wide one bounces off the rail', () => {
  const gallop = roll(0.8);
  assert.equal(gallop.outcome.zone, 'gallop');
  assert.equal(gallop.outcome.points, 3);
  assert.equal(gallop.outcome.row, ROWS - 1, 'a straight roll at this power reaches the apex');
  assert.equal(roll(1).outcome.kind, 'gutter');

  const bank = roll(0.75, 0.4);
  assert.ok(types(bank.events, bank.launched).includes('rail'));
  const xs = bank.frames.filter((_, i) => i % 6 === bank.launched * 2).filter((v) => !Number.isNaN(v));
  assert.ok(xs.every((x) => Math.abs(x) <= BOARD.halfWidth - PHYSICS.ballRadius + 1e-6));
});

test('a returning ball knocks a resting one, and both settle apart', () => {
  const table: BallAtRest[] = [
    { id: 0, x: 0.45, y: BOARD.ballStartY },
    { id: 1, x: 0, y: BOARD.ballStartY },
  ];
  const sim = simulateRoll({ ball: 1, x: 0, y: 2.0, vx: 0.8, vy: 0 }, table);
  assert.ok(types(sim.events).includes('ball'), 'expected a ball-on-ball collision');
  assert.equal(sim.final.length, 2);
  const [p, q] = sim.final;
  assert.ok(Math.hypot(p!.x - q!.x, p!.y - q!.y) >= PHYSICS.ballRadius * 2 - 1e-3);
  assert.notEqual(q!.x, 0.45, 'the resting ball was moved');
});

test('ordinal', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});

test('one roll at a time; points land when the table settles; the ball comes back through the chute', () => {
  const { game, advance } = makeGame(['a', 'b']);
  const input = { type: 'roll' as const, ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55) };
  game.onInput('a', input);
  assert.equal(game.playerState('a').me.flight, null, 'no rolling during the countdown');

  advance(COUNTDOWN_MS);
  assert.equal(game.hostState().phase, 'racing');
  assert.equal(game.playerState('a').me.balls.length, BALLS_PER_PLAYER);

  const sim = simulateRoll({ ball: 1, x: 0, y: BOARD.ballStartY, ...velocity(0.55) }, startTable());
  game.onInput('a', input);
  game.onInput('a', { ...input, ball: 0, ...velocity(0.8) });
  let s = game.playerState('a');
  assert.ok(s.me.flight, 'roll is in progress');
  assert.equal(s.me.flight!.launch.ball, 1, 'second roll ignored while the table is live');
  assert.equal(s.me.balls.find((b) => b.id === 1)!.status, 'rolling');
  assert.equal(s.me.progress, 0, 'no points until it drops in');
  assert.ok(s.cooldownMs > 0);

  advance(sim.outcome.endedAt + 50);
  s = game.playerState('a');
  assert.equal(s.me.progress, 1);
  assert.equal(s.me.rolls, 1);
  assert.equal(s.me.lastRoll?.zone, 'walk');
  assert.equal(s.me.flight, null);
  assert.equal(s.cooldownMs, 0);
  assert.equal(s.me.balls.find((b) => b.id === 1)!.status, 'returning');
  assert.equal(s.me.balls.filter((b) => b.status === 'resting').length, 2);

  advance(CHUTE_DELAY_MS + 100);
  s = game.playerState('a');
  const back = s.me.balls.find((b) => b.id === 1)!;
  assert.equal(back.status, 'resting');
  assert.equal(back.y, BOARD.ballStartY);
  for (const other of s.me.balls) if (other.id !== 1) assert.ok(Math.abs(other.x - back.x) >= PHYSICS.ballRadius * 2);
  assert.equal(game.playerState('b').leaderProgress, 1);
});

test('a drop moves the ball but is not a roll', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS);
  game.onInput('a', { type: 'roll', ball: 0, x: -2.0, y: 1.5, vx: 0, vy: 0 });
  assert.ok(game.playerState('a').me.flight);
  advance(4000);
  const s = game.playerState('a');
  assert.equal(s.me.flight, null);
  assert.equal(s.me.rolls, 0);
  assert.equal(game.hostState().feed.length, 0);
  const b = s.me.balls.find((k) => k.id === 0)!;
  assert.equal(b.status, 'resting');
  assert.ok(Math.abs(b.x - -2.0) < 0.3, `settled near where it was dropped, at ${b.x}`);
});

test('first racer to the line wins, then the game finishes after the linger', () => {
  const { game, advance } = makeGame(['a', 'b']);
  advance(COUNTDOWN_MS);
  const rollAny = (id: string, power: number) => {
    const ball = game.playerState(id).me.balls.find((b) => b.status === 'resting');
    if (ball) game.onInput(id, { type: 'roll', ball: ball.id, x: 0, y: BOARD.ballStartY, ...velocity(power) });
  };
  let rolls = 0;
  while (game.hostState().phase !== 'finished' && rolls < 40) {
    rollAny('a', 0.8);
    rollAny('b', 0.55);
    advance(3500);
    rolls++;
  }
  assert.equal(rolls, TRACK_LENGTH / 3);
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
  game.onInput('a', { type: 'roll', ball: 7, x: 0, y: 0.3, vx: 0, vy: 5 });
  game.onInput('nobody', { type: 'roll', ball: 0, x: 0, y: 0.3, vx: 0, vy: 5 });
  assert.equal(game.playerState('a').me.flight, null);
  assert.equal(game.playerState('a').me.rolls, 0);
});
