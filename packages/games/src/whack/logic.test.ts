import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  FIELD,
  LIFE_TICKS,
  MOLE,
  ROUND_MS,
  RULES,
  activeMoles,
  createTable,
  holeCount,
  holePos,
  isUp,
  moleHeight,
  pointSegmentDistance,
  slice,
  stepTable,
  stunned,
  tablesMatch,
  type TableEvent,
  type TableState,
} from './logic';
import { WhackGame } from './server';
import type { PlayerInfo } from '@funfair/shared';

function player(id: string): PlayerInfo {
  return { id, name: id, color: '#fff', avatar: '🔨', connected: true, isVip: id === 'a' };
}

function makeGame(ids: string[]) {
  let clock = 0;
  const game = new WhackGame({ players: ids.map(player), random: () => 0.42, now: () => clock });
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

/** Step until a mole of the wanted kind is up, and return it. */
function untilUp(t: TableState, events: TableEvent[], kind?: string, limit = 6000) {
  for (let i = 0; i < limit; i++) {
    stepTable(t, events);
    const up = activeMoles(t).find((m) => isUp(m) && (!kind || m.kind === kind));
    if (up) return up;
  }
  return null;
}

/** A short stroke right across one hole, close enough to catch only that mole. */
function sliceThrough(t: TableState, hole: number, events: TableEvent[]) {
  const p = holePos(hole);
  slice(t, { type: 'slice', x0: p.x - 0.25, y0: p.y - 0.25, x1: p.x + 0.25, y1: p.y + 0.25, tick: t.tick }, events);
}

test('the field is deterministic: the same seed brings up the same moles', () => {
  const a = createTable(1234);
  const b = createTable(1234);
  const ea: TableEvent[] = [];
  const eb: TableEvent[] = [];
  for (let i = 0; i < 2000; i++) {
    stepTable(a, ea);
    stepTable(b, eb);
    assert.ok(tablesMatch(a, b, 0));
  }
  assert.deepEqual(ea, eb);
  assert.ok(ea.filter((e) => e.type === 'spawn').length > 20, 'plenty of moles came up');
  const other = createTable(99);
  const eo: TableEvent[] = [];
  for (let i = 0; i < 2000; i++) stepTable(other, eo);
  assert.notDeepEqual(
    eo.filter((e) => e.type === 'spawn').map((e) => e.hole),
    ea.filter((e) => e.type === 'spawn').map((e) => e.hole),
    'a different seed brings up a different pattern',
  );
});

test('moles rise out of the hole, hold, and duck back down', () => {
  assert.ok(moleHeight(0, LIFE_TICKS.mole) < MOLE.hitZ, 'starts underground');
  assert.ok(Math.abs(moleHeight(MOLE.riseTicks, LIFE_TICKS.mole) - MOLE.up) < 1e-9);
  assert.ok(Math.abs(moleHeight(LIFE_TICKS.mole - MOLE.duckTicks, LIFE_TICKS.mole) - MOLE.up) < 1e-9);
  assert.ok(moleHeight(LIFE_TICKS.mole, LIFE_TICKS.mole) < MOLE.hitZ, 'back underground');
  assert.ok(moleHeight(MOLE.riseTicks / 2, LIFE_TICKS.mole) > moleHeight(0, LIFE_TICKS.mole), 'rising');
});

test('holes sit on a grid in front of the player', () => {
  assert.equal(holeCount, FIELD.cols * FIELD.rows);
  const first = holePos(0);
  const last = holePos(holeCount - 1);
  assert.ok(first.y < last.y, 'rows run away from the player');
  assert.ok(first.x < 0 && last.x > 0, 'columns straddle the middle');
  assert.equal(holePos(1).x, 0);
});

test('a stroke whacks the mole it passes through and misses the rest', () => {
  const t = createTable(7);
  const events: TableEvent[] = [];
  const mole = untilUp(t, events, 'mole');
  assert.ok(mole, 'a mole came up');
  sliceThrough(t, mole!.hole, events);
  const hit = events.find((e) => e.type === 'whack' && e.mole === mole!.id);
  assert.ok(hit, 'the mole the stroke passed through was whacked');
  assert.equal(mole!.status, 'hit');
  assert.ok(mole!.points > 0);
  assert.equal(t.combo, 1);
  // A second stroke over the same hole does nothing: it's already down.
  const before = events.length;
  sliceThrough(t, mole!.hole, events);
  assert.equal(events.length, before, 'nothing left in that row to hit');
});

test('a mole still underground cannot be cut', () => {
  const t = createTable(3);
  const events: TableEvent[] = [];
  // Step to just after a spawn, while the mole is still on its way up.
  let fresh = null;
  for (let i = 0; i < 6000 && !fresh; i++) {
    stepTable(t, events);
    fresh = activeMoles(t).find((m) => t.tick - m.spawnTick < 4) ?? null;
  }
  assert.ok(fresh);
  assert.ok(!isUp(fresh!));
  sliceThrough(t, fresh!.hole, events);
  assert.equal(fresh!.status, 'active', 'still coming up, so not hit');
});

test('hits in quick succession chain a combo worth more each time', () => {
  const t = createTable(11);
  const events: TableEvent[] = [];
  // Wait until two moles are up at once, then take them one after the other.
  let pair: ReturnType<typeof activeMoles> = [];
  for (let i = 0; i < 8000; i++) {
    stepTable(t, events);
    pair = activeMoles(t).filter((m) => isUp(m) && m.kind === 'mole');
    if (pair.length >= 2) break;
  }
  assert.ok(pair.length >= 2, 'two moles were up together');
  const points: number[] = [];
  for (const m of pair.slice(0, 2)) {
    const before = events.length;
    sliceThrough(t, m.hole, events);
    const hit = events.slice(before).find((e) => e.type === 'whack' && e.mole === m.id);
    assert.ok(hit);
    points.push(hit!.points!);
  }
  assert.equal(points[0], RULES.molePoints);
  assert.equal(points[1], RULES.molePoints * 2, 'the second in a chain is worth double');
  assert.equal(t.combo, 2);
});

test('cutting a bomb costs points and stuns the blade', () => {
  const t = createTable(5);
  const events: TableEvent[] = [];
  const bomb = untilUp(t, events, 'bomb');
  assert.ok(bomb, 'a bomb came up');
  sliceThrough(t, bomb!.hole, events);
  const boom = events.find((e) => e.type === 'bomb');
  assert.ok(boom);
  assert.equal(boom!.points, -RULES.bombPenalty);
  assert.equal(t.combo, 0);
  assert.ok(stunned(t), 'the blade is dead for a moment');
  // A mole up during the stun survives a stroke.
  const mole = untilUp(t, events, 'mole', 200);
  if (mole && stunned(t)) {
    sliceThrough(t, mole.hole, events);
    assert.equal(mole.status, 'active', 'stunned strokes do nothing');
  }
  for (let i = 0; i < RULES.stunTicks + 2; i++) stepTable(t, events);
  assert.ok(!stunned(t));
});

test('a mole that is never cut ducks back down and counts as one that got away', () => {
  const t = createTable(21);
  const events: TableEvent[] = [];
  for (let i = 0; i < 1500; i++) stepTable(t, events);
  const escaped = events.filter((e) => e.type === 'escape');
  assert.ok(escaped.length > 5);
  assert.ok(escaped.every((e) => e.kind !== 'bomb'), 'a bomb going away is not a miss');
});

test('the stroke reaches as far as the blade is wide', () => {
  assert.equal(pointSegmentDistance(0, 0, -1, 0, 1, 0), 0);
  assert.equal(pointSegmentDistance(0, 2, -1, 0, 1, 0), 2);
  assert.equal(pointSegmentDistance(3, 0, -1, 0, 1, 0), 2, 'past the end of the stroke');
});

test('the round scores whacks and ends on the clock', () => {
  const { game, advance } = makeGame(['a', 'b']);
  const table = () => game.playerState('a').table;
  slice(table(), { type: 'slice', x0: -3, y0: 1, x1: 3, y1: 1, tick: 0 });
  advance(COUNTDOWN_MS);
  // Sweep the whole field over and over: everything up gets whacked.
  for (let i = 0; i < 60; i++) {
    const t = game.playerState('a').table;
    for (let row = 0; row < FIELD.rows; row++) {
      const y = FIELD.frontY + row * FIELD.gapY;
      game.onInput('a', { type: 'slice', x0: -3, y0: y, x1: 3, y1: y, tick: t.tick });
    }
    advance(300);
  }
  const host = game.hostState();
  const a = host.racers.find((r) => r.playerId === 'a')!;
  const b = host.racers.find((r) => r.playerId === 'b')!;
  assert.ok(a.whacked > 5, 'sweeping the field whacks moles');
  assert.ok(a.score > 5);
  assert.ok(a.bestCombo >= 2);
  assert.equal(b.score, 0, 'the other player never swung');
  assert.ok(b.missed > 0, 'and let moles get away');
  assert.equal(host.winnerId, null);
  advance(ROUND_MS - host.raceMs + 100);
  assert.equal(game.hostState().phase, 'finished');
  assert.equal(game.hostState().winnerId, 'a');
  assert.equal(game.isFinished(), false);
  advance(FINISH_LINGER_MS);
  assert.equal(game.isFinished(), true);
  assert.match(game.results().standings[0]!.label, /pts/);
});

test('malformed input is rejected', () => {
  const { game, advance } = makeGame(['a']);
  advance(COUNTDOWN_MS);
  // @ts-expect-error deliberately malformed
  game.onInput('a', { type: 'slice', x0: 'left' });
  // @ts-expect-error deliberately malformed
  game.onInput('a', null);
  // @ts-expect-error deliberately malformed
  game.onInput('a', { type: 'whack', tick: 0 });
  assert.equal(game.playerState('a').me.score, 0);
});
