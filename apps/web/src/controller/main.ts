import type { ErrorCode, GameMeta, PlayerInfo, RoomSnapshot, ServerMessage } from '@funfair/shared';
import type { ControllerView } from '@funfair/shared/client';
import { MAX_NAME_LENGTH } from '@funfair/shared';
import { findClientGame } from '@funfair/games/client';
import { Connection, type ConnectionStatus } from '../net';
import { h, playerChip, standingsList, statusPill } from '../ui';
import { holdWakeLock, registerServiceWorker } from '../pwa';
import '../style.css';

const SESSION_KEY = 'funfair.player';

interface PlayerSession {
  roomCode: string;
  playerId: string;
  token: string;
  name: string;
}

const app = document.getElementById('app')!;
const urlRoom = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';

let session: PlayerSession | null = loadSession();
let room: RoomSnapshot | null = null;
let status: ConnectionStatus = 'connecting';
let screen = '';
let error: string | null = null;
let pendingJoin: { roomCode: string; name: string } | null = null;
let gameView: { id: string; view: ControllerView } | null = null;
let gameRoot: HTMLElement | null = null;

// A code in the URL that doesn't match the saved seat means a new party.
if (session && urlRoom && session.roomCode !== urlRoom) {
  clearSession();
  session = null;
}

const conn = new Connection({
  onOpen() {
    if (session) conn.send({ type: 'player:resume', roomCode: session.roomCode, playerId: session.playerId, token: session.token });
    else if (pendingJoin) conn.send({ type: 'player:join', ...pendingJoin });
  },
  onStatus(s) {
    status = s;
    renderStatus();
  },
  onMessage: handleMessage,
});

function handleMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'player:welcome': {
      const name = pendingJoin?.name ?? session?.name ?? '';
      session = { roomCode: msg.roomCode, playerId: msg.playerId, token: msg.token, name };
      pendingJoin = null;
      error = null;
      saveSession(session);
      history.replaceState(null, '', `/play/?room=${msg.roomCode}`);
      break;
    }
    case 'room':
      room = msg.room;
      render();
      break;
    case 'game:player': {
      const me = self();
      if (room && me) ensureGameView(msg.gameId)?.update(msg.state, me, room.players);
      break;
    }
    case 'error':
      onError(msg.code, msg.message);
      break;
  }
}

function onError(code: ErrorCode, message: string) {
  if (code === 'session-expired' || code === 'room-not-found') {
    clearSession();
    session = null;
    room = null;
    pendingJoin = null;
  }
  error = message;
  screen = '';
  render();
}

function self(): PlayerInfo | undefined {
  return room?.players.find((p) => p.id === session?.playerId);
}

function render() {
  const me = self();
  let next: string;
  if (!session || !room || !me) next = 'join';
  else if (room.phase === 'playing') next = `playing:${room.gameId}`;
  else next = room.phase;

  if (next !== screen) {
    screen = next;
    teardownGame();
    gameRoot = null;
    app.replaceChildren(next === 'join' ? joinScreen() : next === 'lobby' ? lobbyScreen() : next === 'results' ? resultsScreen() : playingScreen());
  } else if (next === 'lobby' || next === 'results') {
    app.replaceChildren(next === 'lobby' ? lobbyScreen() : resultsScreen());
  } else if (next === 'join' && error) {
    app.replaceChildren(joinScreen());
  }
  void holdWakeLock(next.startsWith('playing'));
  renderStatus();
}

function joinScreen(): HTMLElement {
  const codeInput = h('input', {
    class: 'input input-code',
    name: 'code',
    placeholder: 'ROOM',
    maxlength: '4',
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    inputmode: 'text',
  }) as HTMLInputElement;
  codeInput.value = pendingJoin?.roomCode ?? urlRoom;
  const nameInput = h('input', {
    class: 'input',
    name: 'name',
    placeholder: 'Your name',
    maxlength: String(MAX_NAME_LENGTH),
    autocomplete: 'nickname',
    enterkeyhint: 'go',
  }) as HTMLInputElement;
  nameInput.value = pendingJoin?.name ?? loadLastName();
  const form = h(
    'form',
    {
      class: 'join-form',
      onSubmit: (ev) => {
        ev.preventDefault();
        const roomCode = codeInput.value.trim().toUpperCase();
        const name = nameInput.value.trim();
        if (roomCode.length !== 4) return setError('Room codes are 4 letters.');
        if (!name) return setError('Pick a name.');
        error = null;
        pendingJoin = { roomCode, name };
        saveLastName(name);
        if (!conn.send({ type: 'player:join', roomCode, name })) conn.kick();
        (form.querySelector('button') as HTMLButtonElement).disabled = true;
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'Room code'), codeInput),
    h('label', { class: 'field' }, h('span', {}, 'Name'), nameInput),
    error ? h('p', { class: 'error' }, error) : null,
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Join the party'),
  );
  return h('main', { class: 'screen join' }, h('h1', { class: 'brand brand-big' }, '🎪 Funfair'), h('p', { class: 'tagline' }, 'Enter the code on the big screen.'), form, h('div', { class: 'ctl-footer' }, h('span', { id: 'status-slot' })));
}

function setError(msg: string) {
  error = msg;
  app.replaceChildren(joinScreen());
}

function lobbyScreen(): HTMLElement {
  const me = self()!;
  return h(
    'main',
    { class: 'screen lobby' },
    h('div', { class: 'me-card', style: `--c:${me.color}` }, h('span', { class: 'me-avatar' }, me.avatar), h('div', {}, h('div', { class: 'me-name' }, me.name), h('div', { class: 'muted' }, me.isVip ? '👑 You are the VIP – you pick the game' : 'Waiting for the VIP to start a game'))),
    room!.hostConnected ? null : h('p', { class: 'error' }, 'The big screen is disconnected.'),
    h('div', { class: 'chips' }, ...room!.players.map((p) => playerChip(p, { me: p.id === me.id }))),
    me.isVip ? gamePicker() : null,
    error ? h('p', { class: 'error' }, error) : null,
    h('div', { class: 'ctl-footer' }, h('span', {}, `Room ${room!.code}`), h('span', { id: 'status-slot' }), h('button', { class: 'btn btn-link', onClick: leave }, 'Leave')),
  );
}

function gamePicker(): HTMLElement {
  const count = room!.players.filter((p) => p.connected).length;
  return h(
    'section',
    { class: 'game-list' },
    h('h2', {}, 'Pick a game'),
    ...room!.games.map((g: GameMeta) => {
      const enough = count >= g.minPlayers;
      return h(
        'button',
        { class: 'game-card', disabled: !enough, onClick: () => start(g.id) },
        h('span', { class: 'game-card-name' }, g.name),
        h('span', { class: 'game-card-tagline' }, g.tagline),
        h('span', { class: 'game-card-meta' }, enough ? `${g.minPlayers}–${g.maxPlayers} players · tap to start` : `Needs ${g.minPlayers}+ players`),
      );
    }),
  );
}

function playingScreen(): HTMLElement {
  gameRoot = h('div', { class: 'game-root' });
  return h('main', { class: 'screen playing' }, gameRoot);
}

function resultsScreen(): HTMLElement {
  const me = self()!;
  const game = findClientGame(room!.gameId ?? '');
  return h(
    'main',
    { class: 'screen results' },
    h('h2', { class: 'results-title' }, `${game?.meta.name ?? 'Game'} · Results`),
    room!.results ? standingsList(room!.results, room!.players, me.id) : null,
    me.isVip
      ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onClick: () => start(room!.gameId ?? '') }, 'Play again'), h('button', { class: 'btn', onClick: () => conn.send({ type: 'player:lobby' }) }, 'Back to lobby'))
      : h('p', { class: 'muted' }, 'Waiting for the VIP…'),
    error ? h('p', { class: 'error' }, error) : null,
    h('div', { class: 'ctl-footer' }, h('span', {}, `Room ${room!.code}`), h('span', { id: 'status-slot' })),
  );
}

function start(gameId: string) {
  error = null;
  conn.send({ type: 'player:start', gameId });
}

function leave() {
  conn.close();
  clearSession();
  session = null;
  room = null;
  screen = '';
  history.replaceState(null, '', '/play/');
  render();
  conn.connect();
}

function renderStatus() {
  const slot = document.getElementById('status-slot');
  if (slot) slot.replaceChildren(statusPill(status));
}

function ensureGameView(gameId: string): ControllerView | null {
  if (gameView?.id === gameId) return gameView.view;
  if (!gameRoot) return null;
  teardownGame();
  const def = findClientGame(gameId);
  if (!def) return null;
  gameView = { id: gameId, view: def.mountController(gameRoot, (input) => conn.send({ type: 'player:input', input })) };
  return gameView.view;
}

function teardownGame() {
  gameView?.view.destroy();
  gameView = null;
}

function loadSession(): PlayerSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as PlayerSession) : null;
  } catch {
    return null;
  }
}
function saveSession(s: PlayerSession) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
function loadLastName(): string {
  try {
    return localStorage.getItem('funfair.name') ?? '';
  } catch {
    return '';
  }
}
function saveLastName(name: string) {
  try {
    localStorage.setItem('funfair.name', name);
  } catch {
    /* ignore */
  }
}

registerServiceWorker();
render();
conn.connect();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') conn.kick();
});
