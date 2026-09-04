import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD,
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  HOLES,
  PHYSICS,
  RETURN_DELAY_MS,
  ROWS,
  TRACK_LENGTH,
  clampLaunch,
  ordinal,
  simulateRoll,
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

/** Launch velocity for a power (0..1) and a lateral fraction of the speed. */
function launch(power: number, lateral = 0) {
  const v = power * PHYSICS.maxLaunchSpeed;
  const vx = v * lateral;
  return { vx, vy: Math.sqrt(v * v - vx * vx) };
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

test('the pyramid has the right shape', () => {
  assert.equal(HOLES.length, (ROWS * (ROWS + 1)) / 2);
  const count = (z: string) => HOLES.filter((h) => h.zone === z).length;
  assert.equal(count('gallop'), 3);
  assert.equal(count('trot'), 7);
  assert.equal(count('walk'), 5);
  assert.ok(HOLES.every((h) => h.y > BOARD.rampLength && h.y < BOARD.gutterY));
});

test('clampLaunch limits speed and angle', () => {
  const fast = clampLaunch(0, 100);
  assert.ok(Math.abs(fast.vy - PHYSICS.maxLaunchSpeed) < 1e-9);
  const sideways = clampLaunch(10, 1);
  assert.ok(Math.abs(sideways.vx) <= PHYSICS.maxLateralRatio * Math.hypot(sideways.vx, sideways.vy) + 1e-9);
  assert.equal(clampLaunch(0, -5).vy, 0);
});

test('simulateRoll is deterministic', () => {
  const { vx, vy } = launch(0.7, 0.2);
  const a = simulateRoll(vx, vy);
  const b = simulateRoll(vx, vy);
  assert.deepEqual(a.outcome, b.outcome);
  assert.deepEqual(a.frames, b.frames);
  assert.deepEqual(a.events, b.events);
});

test('a gentle roll comes back down the ramp', () => {
  const { vx, vy } = launch(0.3);
  const sim = simulateRoll(vx, vy);
  assert.equal(sim.outcome.kind, 'back');
  assert.equal(sim.outcome.points, 0);
  const lastY = sim.frames[sim.frames.length - 1]!;
  assert.ok(lastY <= BOARD.ballStartY + 0.05);
  // The ball went up before it came back.
  assert.ok(Math.max(...sim.frames.filter((_, i) => i % 2 === 1)) > 1);
  // …and bounced off the front bumper at least twice before settling.
  const bumps = sim.events.filter((e) => e.type === 'bumper');
  assert.ok(bumps.length >= 2, `expected bumper bounces, got ${bumps.length}`);
  // Each rebound is smaller than the last.
  const ys = sim.frames.filter((_, i) => i % 2 === 1);
  const firstBump = sim.frames.length / 2 - Math.round((sim.outcome.endedAt - bumps[0]!.t) / PHYSICS.stepMs);
  const peakAfter = Math.max(...ys.slice(firstBump));
  assert.ok(peakAfter > BOARD.ballStartY + 0.1 && peakAfter < 3, `rebound peak ${peakAfter}`);
});

test('the right speed drops into the front row; the lip rejects a crawl; too fast skips', () => {
  const walk = simulateRoll(launch(0.55).vx, launch(0.55).vy);
  assert.equal(walk.outcome.kind, 'hit');
  assert.equal(walk.outcome.zone, 'walk');
  assert.equal(walk.outcome.row, 0);
  assert.equal(walk.outcome.col, 2);
  assert.ok(!types(walk.events).includes('skip'));

  // Somewhere in the low-power range a ball creeps up to a lip, fails to climb it, and comes back.
  let lipped = 0;
  for (let power = 0.4; power < 0.75; power += 0.01) {
    for (const lateral of [0, 0.1, 0.2]) {
      const sim = simulateRoll(launch(power, lateral).vx, launch(power, lateral).vy);
      if (types(sim.events).includes('lip') && sim.outcome.kind === 'back') lipped++;
    }
  }
  assert.ok(lipped > 0, 'no roll bounced off a lip');

  const quick = simulateRoll(launch(0.65).vx, launch(0.65).vy);
  assert.ok(types(quick.events).includes('skip'), 'ball should skip the first hole');
  assert.equal(quick.outcome.kind, 'hit');
});

test('a hard straight roll reaches the gallop triangle; a wide one bounces off the rail', () => {
  const gallop = simulateRoll(launch(0.8).vx, launch(0.8).vy);
  assert.equal(gallop.outcome.zone, 'gallop');
  assert.equal(gallop.outcome.points, 3);
  assert.equal(gallop.outcome.row, ROWS - 1, 'a straight roll at this power reaches the apex');
  assert.equal(simulateRoll(0, PHYSICS.maxLaunchSpeed).outcome.kind, 'gutter');

  const bank = simulateRoll(launch(0.75, 0.4).vx, launch(0.75, 0.4).vy);
  assert.ok(types(bank.events).includes('rail'));
  assert.ok(bank.frames.filter((_, i) => i % 2 === 0).every((x) => Math.abs(x) <= BOARD.halfWidth - PHYSICS.ballRadius + 1e-6));
});

test('ordinal', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});

test('one ball at a time; points land when the ball does', () => {
  const { game, advance } = makeGame(['a', 'b']);
  game.onInput('a', { type: 'roll', ...launch(0.5) });
  assert.equal(game.playerState('a').me.ball, null, 'no rolling during the countdown');

  advance(COUNTDOWN_MS);
  assert.equal(game.hostState().phase, 'racing');

  const sim = simulateRoll(launch(0.55).vx, launch(0.55).vy);
  game.onInput('a', { type: 'roll', ...launch(0.55) });
  game.onInput('a', { type: 'roll', ...launch(0.8) });
  let s = game.playerState('a');
  assert.ok(s.me.ball, 'ball is in play');
  assert.ok(Math.abs(s.me.ball!.vy - launch(0.55).vy) < 1e-9, 'second roll ignored while the first is in play');
  assert.equal(s.me.progress, 0, 'no points until it drops in');
  assert.ok(s.cooldownMs > 0);

  advance(sim.outcome.endedAt + 50);
  s = game.playerState('a');
  assert.equal(s.me.progress, 1);
  assert.equal(s.me.rolls, 1);
  assert.equal(s.me.lastRoll?.zone, 'walk');
  assert.ok(s.me.ball, 'ball still shown until the return delay passes');

  advance(RETURN_DELAY_MS + 50);
  s = game.playerState('a');
  assert.equal(s.me.ball, null);
  assert.equal(s.cooldownMs, 0);
  assert.equal(game.playerState('b').leaderProgress, 1);
});

test('first racer to the line wins, then the game finishes after the linger', () => {
  const { game, advance } = makeGame(['a', 'b']);
  advance(COUNTDOWN_MS);
  let rolls = 0;
  while (game.hostState().phase !== 'finished' && rolls < 40) {
    game.onInput('a', { type: 'roll', ...launch(0.8) });
    game.onInput('b', { type: 'roll', ...launch(0.55) });
    advance(3000);
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
  game.onInput('a', { type: 'roll', vx: 0, vy: -3 });
  game.onInput('nobody', { type: 'roll', vx: 0, vy: 5 });
  assert.equal(game.playerState('a').me.ball, null);
  assert.equal(game.playerState('a').me.rolls, 0);
});
