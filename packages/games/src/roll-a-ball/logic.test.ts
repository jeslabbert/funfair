import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIM_UNITS,
  COUNTDOWN_MS,
  FINISH_LINGER_MS,
  HOLES,
  MAX_POWER,
  MIN_POWER,
  ROLL_COOLDOWN_MS,
  ROWS,
  TRACK_LENGTH,
  ordinal,
  resolveRoll,
  type RollResult,
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
    clock += ms;
    game.tick(ms);
  };
  return { game, advance };
}

test('resolveRoll: depth picks the row, aim picks the hole, zones follow the pyramid', () => {
  assert.equal(resolveRoll(0.1, 0).kind, 'short');
  assert.equal(resolveRoll(0.99, 0).kind, 'gutter');
  assert.equal(resolveRoll(5, 0).kind, 'gutter');
  assert.equal(resolveRoll(-1, 0).kind, 'short');

  // Front row, centre: walk.
  assert.deepEqual(pick(resolveRoll(0.2, 0)), { kind: 'hit', zone: 'walk', points: 1, row: 0, col: 3 });
  // Front row, hard to the side: the arrow's arm – trot.
  assert.deepEqual(pick(resolveRoll(0.2, 0.85)), { kind: 'hit', zone: 'trot', points: 2, row: 0, col: 6 });
  // Even further out misses the board.
  assert.equal(resolveRoll(0.2, 1).kind, 'wide');
  // Middle row is the arrow tip: trot all the way across.
  assert.deepEqual(pick(resolveRoll(0.5, 0)), { kind: 'hit', zone: 'trot', points: 2, row: 3, col: 2 });
  assert.equal(resolveRoll(0.5, -0.4).zone, 'trot');
  // Back rows are the gallop triangle; the apex needs a straight roll.
  assert.deepEqual(pick(resolveRoll(0.7, 0)), { kind: 'hit', zone: 'gallop', points: 3, row: 4, col: 1 });
  assert.deepEqual(pick(resolveRoll(0.93, 0.1)), { kind: 'hit', zone: 'gallop', points: 3, row: 6, col: 0 });
  assert.equal(resolveRoll(0.93, 0.2).kind, 'wide');

  // Every hole on the board is reachable and scores.
  for (const h of HOLES) {
    const power = MIN_POWER + (h.row / (ROWS - 1)) * (MAX_POWER - MIN_POWER);
    const r = resolveRoll(power, h.x / AIM_UNITS);
    assert.deepEqual(pick(r), { kind: 'hit', zone: h.zone, points: h.points, row: h.row, col: h.col });
  }
});

test('the pyramid has the right shape', () => {
  assert.equal(HOLES.length, (ROWS * (ROWS + 1)) / 2);
  const count = (z: string) => HOLES.filter((h) => h.zone === z).length;
  assert.equal(count('gallop'), 6);
  assert.equal(count('trot'), 10);
  assert.equal(count('walk'), 12);
});

function pick(r: RollResult) {
  return { kind: r.kind, zone: r.zone, points: r.points, row: r.row, col: r.col };
}

test('ordinal', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});

test('rolls are ignored during countdown and rate limited while racing', () => {
  const { game, advance } = makeGame(['a', 'b']);
  game.onInput('a', { type: 'roll', power: 0.7, aim: 0 });
  assert.equal(game.hostState().racers.find((r) => r.playerId === 'a')!.progress, 0);

  advance(COUNTDOWN_MS);
  assert.equal(game.hostState().phase, 'racing');

  game.onInput('a', { type: 'roll', power: 0.7, aim: 0 });
  game.onInput('a', { type: 'roll', power: 0.7, aim: 0 });
  assert.equal(game.playerState('a').me.progress, 3);
  assert.equal(game.playerState('a').me.rolls, 1);
  assert.ok(game.playerState('a').cooldownMs > 0);

  advance(ROLL_COOLDOWN_MS);
  game.onInput('a', { type: 'roll', power: 0.7, aim: 0 });
  assert.equal(game.playerState('a').me.progress, 6);
  assert.equal(game.playerState('b').leaderProgress, 6);
});

test('first racer to the line wins, then the game finishes after the linger', () => {
  const { game, advance } = makeGame(['a', 'b']);
  advance(COUNTDOWN_MS);
  let rolls = 0;
  while (game.hostState().phase !== 'finished' && rolls < 20) {
    game.onInput('a', { type: 'roll', power: 0.9, aim: 0 });
    game.onInput('b', { type: 'roll', power: 0.2, aim: 0 });
    advance(ROLL_COOLDOWN_MS);
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
  game.onInput('a', { type: 'roll', power: 'lots' });
  // @ts-expect-error deliberately malformed
  game.onInput('a', null);
  game.onInput('nobody', { type: 'roll', power: 0.5, aim: 0 });
  assert.equal(game.playerState('a').me.rolls, 0);
});
