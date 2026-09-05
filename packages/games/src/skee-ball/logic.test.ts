import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BALLS_PER_PLAYER,
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  LANE,
  PHYSICS,
  RINGS,
  ROUND_MS,
  boardFrame,
  boardPoint,
  ballsLeft,
  createTable,
  grabBall,
  launchBall,
  scoreAt,
  stepTable,
  tableBusy,
  tablesMatch,
  type TableEvent,
} from './logic';
import { SkeeBallGame } from './server';
import type { PlayerInfo } from '@funfair/shared';

function player(id: string): PlayerInfo {
  return { id, name: id, color: '#fff', avatar: '🐎', connected: true, isVip: id === 'a' };
}

function makeGame(ids: string[]) {
  let clock = 0;
  const game = new SkeeBallGame({ players: ids.map(player), random: () => 0.5, now: () => clock });
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

/** Roll one ball from the bumper and follow it to the end. */
function throwBall(power: number, lateral = 0) {
  const table = createTable();
  const events: TableEvent[] = [];
  launchBall(table, { ball: 0, x: 0, y: LANE.ballStartY, ...velocity(power, lateral) }, events);
  for (let i = 0; i < 2000 && tableBusy(table); i++) stepTable(table, events);
  const end = events.find((e) => e.type === 'score' || e.type === 'miss');
  return { table, events, ball: table.balls[0]!, end };
}

test('the board scores by ring, pocket and pit', () => {
  assert.equal(scoreAt(0, LANE.ringU), 50);
  assert.equal(scoreAt(0.5, LANE.ringU), 40);
  assert.equal(scoreAt(0.9, LANE.ringU), 30);
  assert.equal(scoreAt(0, LANE.ringU + 1.3), 20);
  assert.equal(scoreAt(2.0, 0.5), 10);
  assert.equal(scoreAt(LANE.pocketX, LANE.pocketU), 100);
  assert.equal(scoreAt(-LANE.pocketX + 0.1, LANE.pocketU - 0.1), 100);
  assert.equal(scoreAt(0, LANE.boardLength + 0.1), 0);
  assert.equal(scoreAt(LANE.boardHalfWidth + 0.1, 1), 0);
  assert.ok(RINGS.every((r, i) => i === 0 || r.r > RINGS[i - 1]!.r), 'rings widen outwards');
});

test('board geometry round-trips', () => {
  for (const u of [0, 1, 2.5, LANE.boardLength]) {
    const p = boardPoint(u);
    const f = boardFrame(p.y, p.z);
    assert.ok(Math.abs(f.d) < 1e-9, 'on the face');
    assert.ok(Math.abs(f.u - u) < 1e-9);
  }
  assert.ok(boardFrame(LANE.boardBaseY - 1, 0).d > 0, 'in front of the board is positive');
});

test('the table is deterministic and snapshots replay exactly', () => {
  const a = createTable();
  const b = createTable();
  launchBall(a, { ball: 0, x: 0.2, y: LANE.ballStartY, ...velocity(0.8, 0.1) });
  launchBall(b, { ball: 0, x: 0.2, y: LANE.ballStartY, ...velocity(0.8, 0.1) });
  const ea: TableEvent[] = [];
  const eb: TableEvent[] = [];
  for (let i = 0; i < 600; i++) {
    stepTable(a, ea);
    stepTable(b, eb);
    assert.ok(tablesMatch(a, b, 0));
  }
  assert.deepEqual(ea, eb);
});

test('a weak roll never reaches the ramp and comes back to the bumper', () => {
  const r = throwBall(0.35);
  assert.equal(r.end, undefined);
  assert.equal(r.ball.status, 'resting');
  assert.ok(Math.abs(r.ball.y - LANE.ballStartY) < 1e-6);
  assert.ok(r.events.some((e) => e.type === 'bumper'));
  assert.equal(ballsLeft(r.table), BALLS_PER_PLAYER, 'still on the table');
});

test('power climbs the rings: pit, then 10 through 50', () => {
  const ladder = [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((p) => throwBall(p).end?.points ?? -1);
  assert.deepEqual(ladder, [10, 10, 10, 10, 10, 20, 30, 40]);
  const flight = throwBall(0.85);
  assert.ok(flight.events.some((e) => e.type === 'jump'), 'it left the ramp');
  const jumpAt = flight.events.find((e) => e.type === 'jump')!.tick;
  const landAt = flight.events.find((e) => e.type === 'land')!.tick;
  const scoreAt = flight.end!.tick;
  assert.ok(landAt > jumpAt + 10, 'and flew for a while');
  assert.ok(scoreAt > landAt, 'then rolled on the board before it dropped in');
  assert.equal(flight.ball.status, 'done');
  assert.equal(flight.ball.points, 30);
});

test('a ball rolls on the board: it bounces off lips, rattles in a cup and drops in', () => {
  // Land a ball in the 20 cup with some speed down the face.
  const table = createTable();
  const b = table.balls[0]!;
  b.status = 'board';
  b.frozen = false;
  b.x = 0.4;
  b.u = LANE.ringU - 0.9;
  b.vu = -1.5;
  b.vx = 0.5;
  const ev: TableEvent[] = [];
  for (let i = 0; i < 2000 && tableBusy(table); i++) stepTable(table, ev);
  assert.ok(ev.some((e) => e.type === 'lip'), 'it hit a lip on the way');
  assert.equal(b.status, 'done');
  assert.equal(b.points, 20);
  // Rolling down the plain face ends in the 10 trough.
  const t2 = createTable();
  const c = t2.balls[0]!;
  c.status = 'board';
  c.frozen = false;
  c.x = 2.0;
  c.u = 3.5;
  const ev2: TableEvent[] = [];
  for (let i = 0; i < 2000 && tableBusy(t2); i++) stepTable(t2, ev2);
  assert.equal(c.points, 10);
  assert.equal(ev2.find((e) => e.type === 'score')?.u, 0);
});

test('a hard throw bounces off the face and still counts where it ends up', () => {
  const r = throwBall(1);
  assert.ok(r.events.some((e) => e.type === 'hop'));
  assert.ok(r.events.some((e) => e.type === 'land'));
  assert.ok(r.end && r.end.type === 'score' && r.end.points! >= 10);
});

test('an angled throw can find the corner pockets or bounce off the walls', () => {
  let pocket = false;
  let wall = false;
  for (let p = 0.7; p <= 1.001; p += 0.01) {
    for (let lat = 0.1; lat <= 0.45; lat += 0.05) {
      const r = throwBall(p, lat);
      if (r.end?.points === 100) pocket = true;
      if (r.events.some((e) => e.type === 'wall')) wall = true;
    }
  }
  assert.ok(pocket, 'some angled throw hits a 100 pocket');
  assert.ok(wall, 'some angled throw bounces off a wall');
});

test('grab and rack: balls are picked from the rack and lane, not from the air', () => {
  const table = createTable();
  assert.ok(grabBall(table, 3));
  assert.equal(table.balls[3]!.status, 'held');
  assert.ok(!grabBall(table, 3));
  launchBall(table, { ball: 3, x: 0, y: 1, ...velocity(0.8) });
  assert.ok(!grabBall(table, 3), 'not while rolling');
  const ev: TableEvent[] = [];
  for (let i = 0; i < 2000 && tableBusy(table); i++) stepTable(table, ev);
  assert.equal(table.balls[3]!.status, 'done');
  assert.ok(!grabBall(table, 3), 'a thrown ball is gone');
  assert.equal(ballsLeft(table), BALLS_PER_PLAYER - 1);
});

test('the round scores as balls land and ends when everyone is out of balls', () => {
  const { game, advance } = makeGame(['a', 'b']);
  const tick = (id: string) => game.playerState(id).table.tick;
  game.onInput('a', { type: 'roll', ball: 0, x: 0, y: LANE.ballStartY, ...velocity(0.85), tick: 0 });
  assert.equal(game.playerState('a').table.balls[0]!.status, 'racked', 'no throwing during the countdown');
  advance(COUNTDOWN_MS);
  for (let i = 0; i < BALLS_PER_PLAYER; i++) {
    game.onInput('a', { type: 'roll', ball: i, x: 0, y: LANE.ballStartY, ...velocity(0.85), tick: tick('a') });
    game.onInput('b', { type: 'roll', ball: i, x: 0, y: LANE.ballStartY, ...velocity(0.7), tick: tick('b') });
    advance(400);
  }
  advance(3000);
  const host = game.hostState();
  assert.equal(host.phase, 'finished', 'out of balls ends the round early');
  assert.ok(host.raceMs < ROUND_MS);
  const a = host.racers.find((r) => r.playerId === 'a')!;
  const b = host.racers.find((r) => r.playerId === 'b')!;
  assert.equal(a.score, 30 * BALLS_PER_PLAYER);
  assert.equal(b.score, 10 * BALLS_PER_PLAYER);
  assert.equal(a.ballsLeft, 0);
  assert.equal(a.landings.length, BALLS_PER_PLAYER);
  assert.equal(host.winnerId, 'a');
  assert.equal(game.playerState('b').leaderScore, a.score);
  assert.equal(game.isFinished(), false);
  advance(FINISH_LINGER_MS);
  assert.equal(game.isFinished(), true);
  assert.deepEqual(game.results().standings.map((s) => s.playerId), ['a', 'b']);
  assert.match(game.results().standings[0]!.label, /270 pts/);
});

test('the clock ends a round with balls unthrown', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS);
  advance(ROUND_MS + 100);
  assert.equal(game.hostState().phase, 'finished');
  assert.equal(game.hostState().racers[0]!.ballsLeft, BALLS_PER_PLAYER);
});

test('malformed input is rejected', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS);
  // @ts-expect-error deliberately malformed
  game.onInput('a', { type: 'roll', vx: 'lots' });
  // @ts-expect-error deliberately malformed
  game.onInput('a', null);
  game.onInput('a', { type: 'roll', ball: 42, x: 0, y: 0.3, vx: 0, vy: 5, tick: 0 });
  assert.ok(game.playerState('a').table.balls.every((b) => b.status === 'racked'));
});
