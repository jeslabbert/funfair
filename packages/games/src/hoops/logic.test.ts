import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALLS_PER_PLAYER,
  COUNTDOWN_MS,
  COURT,
  FINISH_LINGER_MS,
  PHYSICS,
  RETURN_TICKS,
  ROUND_MS,
  ballsReady,
  createTable,
  grabBall,
  shootBall,
  stepTable,
  tableBusy,
  tablesMatch,
  type TableEvent,
} from './logic';
import { HoopsGame } from './server';
import type { PlayerInfo } from '@funfair/shared';

function player(id: string): PlayerInfo {
  return { id, name: id, color: '#fff', avatar: '🏀', connected: true, isVip: id === 'a' };
}

function makeGame(ids: string[]) {
  let clock = 0;
  const game = new HoopsGame({ players: ids.map(player), random: () => 0.5, now: () => clock });
  const advance = (ms: number) => {
    while (ms > 0) {
      const step = Math.min(50, ms);
      clock += step;
      game.tick(step);
      ms -= step;
    }
  };
  return { game, advance };
}

function velocity(power: number, lateral = 0) {
  const v = power * PHYSICS.maxLaunchSpeed;
  const vx = v * lateral;
  return { vx, vy: Math.sqrt(v * v - vx * vx) };
}

/** Throw one ball and follow it until it lands. */
function shoot(power: number, lateral = 0, x = 0) {
  const table = createTable();
  const events: TableEvent[] = [];
  shootBall(table, { ball: 0, x, ...velocity(power, lateral) }, events);
  for (let i = 0; i < 3000 && tableBusy(table); i++) stepTable(table, events);
  const end = events.find((e) => e.type === 'score' || e.type === 'miss');
  return { table, events, ball: table.balls[0]!, end };
}

test('the court is deterministic and snapshots replay exactly', () => {
  const a = createTable();
  const b = createTable();
  shootBall(a, { ball: 0, x: 0.3, ...velocity(0.88, 0.05) });
  shootBall(b, { ball: 0, x: 0.3, ...velocity(0.88, 0.05) });
  const ea: TableEvent[] = [];
  const eb: TableEvent[] = [];
  for (let i = 0; i < 400; i++) {
    stepTable(a, ea);
    stepTable(b, eb);
    assert.ok(tablesMatch(a, b, 0));
  }
  assert.deepEqual(ea, eb);
});

test('a soft throw falls short and a hard one banks off the board', () => {
  const short = shoot(0.7);
  assert.equal(short.end?.type, 'miss');
  assert.equal(short.ball.touched, 0, 'never reached the hoop');
  assert.ok(short.ball.y < COURT.hoopY - COURT.rimR, 'landed in front of the hoop');
  const hard = shoot(0.95);
  assert.ok(hard.events.some((e) => e.type === 'board'), 'hit the backboard');
});

test('power finds the hoop: a swish scores 3, anything off the rim or board scores 2', () => {
  const swish = shoot(0.875);
  assert.equal(swish.end?.type, 'score');
  assert.equal(swish.end?.points, 3);
  assert.equal(swish.end?.swish, true);
  assert.equal(swish.ball.made, true);
  assert.equal(swish.ball.points, 3);
  const bank = shoot(0.9);
  assert.equal(bank.end?.type, 'score');
  assert.equal(bank.end?.points, 2);
  assert.equal(bank.end?.swish, false);
  assert.ok(bank.events.some((e) => e.type === 'board'), 'went in off the glass');
});

test('the rim bounces the ball back out', () => {
  const r = shoot(0.825);
  assert.ok(r.events.some((e) => e.type === 'rim'));
  assert.equal(r.end?.type, 'miss');
});

test('a wide throw hits the cage wall', () => {
  const r = shoot(0.9, 0.3, 1.2);
  assert.ok(r.events.some((e) => e.type === 'wall'));
});

test('balls come back to the rack after they land', () => {
  const table = createTable();
  const events: TableEvent[] = [];
  assert.ok(grabBall(table, 1));
  assert.ok(!grabBall(table, 1), 'not twice');
  shootBall(table, { ball: 1, x: 0, ...velocity(0.7) }, events);
  assert.equal(ballsReady(table), BALLS_PER_PLAYER - 1);
  for (let i = 0; i < 3000 && tableBusy(table); i++) stepTable(table, events);
  assert.equal(table.balls[1]!.status, 'done');
  assert.ok(!grabBall(table, 1), 'not while it is on the floor');
  for (let i = 0; i < RETURN_TICKS + 2; i++) stepTable(table, events);
  assert.equal(table.balls[1]!.status, 'racked');
  assert.ok(events.some((e) => e.type === 'return'));
  assert.equal(ballsReady(table), BALLS_PER_PLAYER);
});

test('the round scores makes and streaks and ends on the clock', () => {
  const { game, advance } = makeGame(['a', 'b']);
  const tick = (id: string) => game.playerState(id).table.tick;
  game.onInput('a', { type: 'shoot', ball: 0, x: 0, ...velocity(0.875), tick: 0 });
  assert.equal(game.playerState('a').table.balls[0]!.status, 'racked', 'no shooting during the countdown');
  advance(COUNTDOWN_MS);
  for (let i = 0; i < 3; i++) {
    game.onInput('a', { type: 'shoot', ball: i, x: 0, ...velocity(0.875), tick: tick('a') });
    game.onInput('b', { type: 'shoot', ball: i, x: 0, ...velocity(0.7), tick: tick('b') });
    advance(300);
  }
  advance(2500);
  const host = game.hostState();
  assert.equal(host.phase, 'playing');
  const a = host.racers.find((r) => r.playerId === 'a')!;
  const b = host.racers.find((r) => r.playerId === 'b')!;
  assert.equal(a.score, 9);
  assert.equal(a.makes, 3);
  assert.equal(a.attempts, 3);
  assert.equal(a.streak, 3);
  assert.equal(b.score, 0);
  assert.equal(b.attempts, 3);
  assert.equal(host.winnerId, null);
  assert.ok(host.feed.some((f) => f.playerId === 'a' && f.swish && f.points === 3));
  assert.ok(host.feed.some((f) => f.playerId === 'b' && f.points === 0));
  advance(ROUND_MS);
  assert.equal(game.hostState().phase, 'finished');
  assert.equal(game.hostState().winnerId, 'a');
  assert.equal(game.isFinished(), false);
  advance(FINISH_LINGER_MS);
  assert.equal(game.isFinished(), true);
  assert.match(game.results().standings[0]!.label, /9 pts/);
});

test('malformed input is rejected', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS);
  // @ts-expect-error deliberately malformed
  game.onInput('a', { type: 'shoot', vx: 'lots' });
  // @ts-expect-error deliberately malformed
  game.onInput('a', null);
  game.onInput('a', { type: 'shoot', ball: 42, x: 0, vx: 0, vy: 5, tick: 0 });
  assert.ok(game.playerState('a').table.balls.every((b) => b.status === 'racked'));
});
