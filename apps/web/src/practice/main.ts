/**
 * Solo practice range: runs a game's server instance locally in the page with
 * a single player and mounts its phone controller on top. No server, no room –
 * a way to learn the controls (and tune the feel) before joining a party.
 */
import type { GameInstance, PlayerInfo } from '@funfair/shared';
import { PLAYER_AVATARS, PLAYER_COLORS } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import { clientGames, findClientGame } from '@funfair/games/client';
import { findServerGame } from '@funfair/games/server';
import { h } from '../ui';
import { holdWakeLock } from '../pwa';
import '../style.css';

const TICK_MS = 50;
const app = document.getElementById('app')!;
const me: PlayerInfo = { id: 'me', name: 'You', color: PLAYER_COLORS[0], avatar: PLAYER_AVATARS[0], connected: true, isVip: true };

const soloGames = clientGames.filter((g) => g.meta.minPlayers <= 1);
const requested = new URLSearchParams(location.search).get('game');
const initial = (requested && findClientGame(requested)?.meta.id) ?? soloGames[0]?.meta.id ?? null;

let timer = 0;
let view: ControllerView | null = null;

function stop() {
  clearInterval(timer);
  view?.destroy();
  view = null;
  void holdWakeLock(false);
}

function pickerScreen(): HTMLElement {
  return h(
    'main',
    { class: 'screen lobby' },
    h('h1', { class: 'brand brand-big' }, '🎪 Practice'),
    h('p', { class: 'tagline' }, 'Play a round on your own to learn the controls.'),
    h(
      'section',
      { class: 'game-list' },
      ...soloGames.map((g) =>
        h(
          'button',
          { class: 'game-card', onClick: () => run(g.meta.id) },
          h('span', { class: 'game-card-name' }, g.meta.name),
          h('span', { class: 'game-card-tagline' }, g.meta.tagline),
        ),
      ),
    ),
    h('div', { class: 'ctl-footer' }, h('a', { class: 'btn btn-link', href: '/play/' }, 'Join a room instead')),
  );
}

function run(gameId: string) {
  stop();
  const client = findClientGame(gameId);
  const server = findServerGame(gameId);
  if (!client || !server) {
    app.replaceChildren(pickerScreen());
    return;
  }
  history.replaceState(null, '', `/practice/?game=${gameId}`);

  const instance: GameInstance = server.create({ players: [me], random: Math.random, now: () => performance.now() });
  const gameRoot = h('div', { class: 'game-root' });
  const bar = h(
    'div',
    { class: 'practice-bar' },
    h('span', { class: 'practice-title' }, 'Practice'),
    h('button', { class: 'btn btn-link', onClick: () => run(gameId) }, 'Restart'),
    h('a', { class: 'btn btn-link', href: '/play/' }, 'Join a room'),
  );
  app.replaceChildren(h('main', { class: 'screen playing' }, bar, gameRoot));

  view = client.mountController(gameRoot, (input) => instance.onInput(me.id, input));
  void holdWakeLock(true);

  let last = performance.now();
  timer = window.setInterval(() => {
    const now = performance.now();
    instance.tick(now - last);
    last = now;
    view?.update(instance.playerState(me.id), me, [me]);
    if (instance.isFinished()) {
      clearInterval(timer);
      bar.replaceChildren(
        h('span', { class: 'practice-title' }, '🏁 Finished'),
        h('button', { class: 'btn btn-primary btn-small', onClick: () => run(gameId) }, 'Race again'),
        h('a', { class: 'btn btn-link', href: '/play/' }, 'Join a room'),
      );
    }
  }, TICK_MS);
}

if (initial && requested) run(initial);
else app.replaceChildren(pickerScreen());
