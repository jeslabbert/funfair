import QRCode from 'qrcode';
import type { RoomSnapshot, ServerMessage } from '@funfair/shared';
import type { HostView } from '@funfair/shared/client';
import { findClientGame } from '@funfair/games/client';
import { Connection, type ConnectionStatus } from '../net';
import { h, playerChip, standingsList, statusPill } from '../ui';
import '../style.css';

const SESSION_KEY = 'funfair.host';

interface HostSession {
  roomCode: string;
  hostToken: string;
}

const app = document.getElementById('app')!;
let room: RoomSnapshot | null = null;
let lanUrl: string | null = null;
let status: ConnectionStatus = 'connecting';
let screen = '';
let gameView: { id: string; view: HostView } | null = null;
let gameRoot: HTMLElement | null = null;

const conn = new Connection({
  onOpen() {
    const saved = loadSession();
    if (saved) conn.send({ type: 'host:resume', roomCode: saved.roomCode, hostToken: saved.hostToken });
    else conn.send({ type: 'host:create' });
  },
  onStatus(s) {
    status = s;
    renderStatus();
  },
  onMessage: handleMessage,
});

function handleMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'host:welcome':
      saveSession({ roomCode: msg.roomCode, hostToken: msg.hostToken });
      lanUrl = msg.lanUrl;
      break;
    case 'room':
      room = msg.room;
      render();
      break;
    case 'game:host':
      if (room) ensureGameView(msg.gameId)?.update(msg.state, room.players);
      break;
    case 'error':
      if (msg.code === 'session-expired' || msg.code === 'room-not-found') {
        clearSession();
        conn.send({ type: 'host:create' });
      } else {
        console.warn('server error', msg);
      }
      break;
  }
}

function render() {
  if (!room) return;
  const next = room.phase === 'playing' ? `playing:${room.gameId}` : room.phase;
  if (next !== screen) {
    screen = next;
    teardownGame();
    gameRoot = null;
    app.replaceChildren();
    if (room.phase === 'lobby') app.append(lobbyScreen());
    else if (room.phase === 'results') app.append(resultsScreen());
    else app.append(playingScreen());
  } else if (room.phase === 'lobby') {
    // Cheap to rebuild; keeps the player list live.
    app.replaceChildren(lobbyScreen());
  }
  renderStatus();
}

function joinUrl(): string {
  const url = new URL('/play/', location.origin);
  // On a dev machine, "localhost" is useless to a phone – swap in the LAN address.
  if (lanUrl && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    const lan = new URL(lanUrl);
    url.hostname = lan.hostname;
    url.port = location.port || lan.port;
  }
  if (room) url.searchParams.set('room', room.code);
  return url.toString();
}

function lobbyScreen(): HTMLElement {
  const url = joinUrl();
  const qr = h('canvas', { class: 'qr' });
  QRCode.toCanvas(qr, url, { width: 240, margin: 1, color: { dark: '#0e1130', light: '#ffffff' } }).catch(() => {});
  const canStart = room!.players.length > 0;
  return h(
    'main',
    { class: 'screen lobby' },
    header(),
    h(
      'section',
      { class: 'join-card' },
      h('div', { class: 'join-steps' },
        h('p', { class: 'join-step' }, '1. On your phone, open'),
        h('p', { class: 'join-url' }, displayUrl(url)),
        h('p', { class: 'join-step' }, '2. Enter the room code'),
        h('p', { class: 'room-code' }, room!.code),
      ),
      h('div', { class: 'qr-wrap' }, qr, h('p', { class: 'qr-caption' }, 'or scan to join')),
    ),
    h(
      'section',
      { class: 'players' },
      room!.players.length === 0
        ? h('p', { class: 'muted' }, 'Waiting for players… the first to join becomes the VIP 👑')
        : h('div', { class: 'chips' }, ...room!.players.map((p) => playerChip(p, { large: true }))),
      h('p', { class: 'muted' }, canStart ? 'The VIP picks a game from their phone to start.' : ''),
    ),
    footer(),
  );
}

function playingScreen(): HTMLElement {
  gameRoot = h('div', { class: 'game-root' });
  const game = findClientGame(room!.gameId ?? '');
  return h('main', { class: 'screen playing' }, h('div', { class: 'topbar' }, h('span', { class: 'brand' }, '🎪 Funfair'), h('span', { class: 'topbar-game' }, game?.meta.name ?? ''), h('span', { class: 'topbar-code' }, `Room ${room!.code}`)), gameRoot);
}

function resultsScreen(): HTMLElement {
  const game = findClientGame(room!.gameId ?? '');
  return h(
    'main',
    { class: 'screen results' },
    header(),
    h('h2', { class: 'results-title' }, `${game?.meta.name ?? 'Game'} · Results`),
    room!.results ? standingsList(room!.results, room!.players) : h('p', { class: 'muted' }, 'No results.'),
    h('p', { class: 'muted' }, 'The VIP can play again or go back to the lobby from their phone.'),
    footer(),
  );
}

function header(): HTMLElement {
  return h('header', { class: 'hero' }, h('h1', { class: 'brand brand-big' }, '🎪 Funfair'), h('p', { class: 'tagline' }, 'Carnival games. Your phone is the controller.'));
}

function footer(): HTMLElement {
  return h('footer', { class: 'host-footer' }, h('span', {}, `Room ${room?.code ?? ''}`), h('span', { id: 'status-slot' }));
}

function renderStatus() {
  const slot = document.getElementById('status-slot');
  if (slot) slot.replaceChildren(statusPill(status));
}

function ensureGameView(gameId: string): HostView | null {
  if (gameView?.id === gameId) return gameView.view;
  if (!gameRoot) return null;
  teardownGame();
  const def = findClientGame(gameId);
  if (!def) return null;
  gameView = { id: gameId, view: def.mountHost(gameRoot) };
  return gameView.view;
}

function teardownGame() {
  gameView?.view.destroy();
  gameView = null;
}

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
}

function loadSession(): HostSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as HostSession) : null;
  } catch {
    return null;
  }
}
function saveSession(s: HostSession) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

app.append(h('main', { class: 'screen' }, header(), h('p', { class: 'muted' }, 'Opening a room…')));
conn.connect();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') conn.kick();
});
