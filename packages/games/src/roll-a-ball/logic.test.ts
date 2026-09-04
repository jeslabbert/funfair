import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoll, ordinal, COUNTDOWN_MS, ROLL_COOLDOWN_MS, TRACK_LENGTH, FINISH_LINGER_MS } from './logic';
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

test('resolveRoll maps power bands to holes and punishes wide aim', () => {
  assert.equal(resolveRoll(0.1, 0).kind, 'short');
  assert.equal(resolveRoll(0.3, 0).points, 1);
  assert.equal(resolveRoll(0.5, 0).points, 2);
  assert.equal(resolveRoll(0.7, 0).points, 3);
  assert.equal(resolveRoll(0.88, 0).points, 5);
  assert.equal(resolveRoll(0.99, 0).kind, 'gutter');
  assert.equal(resolveRoll(0.88, 0.5).kind, 'wide');
  assert.equal(resolveRoll(0.3, 0.5).points, 1);
  assert.equal(resolveRoll(5, 0).kind, 'gutter');
  assert.equal(resolveRoll(-1, 0).kind, 'short');
});

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
    game.onInput('a', { type: 'roll', power: 0.88, aim: 0 });
    game.onInput('b', { type: 'roll', power: 0.3, aim: 0 });
    advance(ROLL_COOLDOWN_MS);
    rolls++;
  }
  assert.equal(rolls, TRACK_LENGTH / 5);
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
