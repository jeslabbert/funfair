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
const params = new URLSearchParams(location.search);
const requested = params.get('game');
/** Obstacles: forced by `?obstacles=on|off`, otherwise decided when the page loads. */
const obstacles = params.get('obstacles') === 'on' ? true : params.get('obstacles') === 'off' ? false : Math.random() < 0.5;
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
  const hasObstacles = client.meta.options?.includes('obstacles') ?? false;
  const query = (on: boolean) => `/practice/?game=${gameId}${hasObstacles ? `&obstacles=${on ? 'on' : 'off'}` : ''}`;
  history.replaceState(null, '', query(obstacles));

  const instance: GameInstance = server.create({ players: [me], random: Math.random, now: () => performance.now(), options: hasObstacles ? { obstacles } : {} });
  // Debug hook for tooling: the authoritative instance.
  (window as unknown as { __practiceGame?: GameInstance }).__practiceGame = instance;
  const gameRoot = h('div', { class: 'game-root' });
  const other = query(!obstacles);
  const variant = hasObstacles
    ? [
        h('span', { class: `practice-mode${obstacles ? ' practice-mode-on' : ''}` }, obstacles ? '⚠ Obstacles' : 'Classic'),
        h('a', { class: 'btn btn-link', href: other, title: 'Play the other variant' }, obstacles ? 'Try classic' : 'Try obstacles'),
      ]
    : [];
  const bar = h(
    'div',
    { class: 'practice-bar' },
    h('span', { class: 'practice-title' }, client.meta.name),
    ...variant,
    h('button', { class: 'btn btn-link', onClick: () => run(gameId) }, 'Restart'),
    h('a', { class: 'btn btn-link', href: '/practice/' }, 'All games'),
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
        h('button', { class: 'btn btn-primary btn-small', onClick: () => run(gameId) }, 'Play again'),
        ...(hasObstacles ? [h('a', { class: 'btn btn-link', href: other }, obstacles ? 'Try classic' : 'Try obstacles')] : []),
        h('a', { class: 'btn btn-link', href: '/practice/' }, 'All games'),
      );
    }
  }, TICK_MS);
}

if (initial && requested) run(initial);
else app.replaceChildren(pickerScreen());
