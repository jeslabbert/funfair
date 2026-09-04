import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { ClientMessage, ErrorCode, ServerMessage } from '@funfair/shared';
import { RoomManager } from './roomManager';
import { normalizeRoomCode } from './codes';
import { createStaticHandler } from './static';
import type { Room } from './room';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST ?? resolve(here, '../../web/dist');

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const rooms = new RoomManager(log);

type Session = { role: 'none' } | { role: 'host'; room: Room } | { role: 'player'; room: Room; playerId: string };

const serveStatic = existsSync(WEB_DIST) ? createStaticHandler(WEB_DIST) : null;
if (!serveStatic) log(`no web build found at ${WEB_DIST}; serving websocket only (use the Vite dev server for the UI)`);

const http = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (serveStatic?.(req, res)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (socket) => {
  let session: Session = { role: 'none' };
  let alive = true;

  socket.on('pong', () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, 30_000);

  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const fail = (code: ErrorCode, message: string) => send({ type: 'error', code, message });

  socket.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return fail('bad-request', 'Malformed message.');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return fail('bad-request', 'Malformed message.');

    switch (msg.type) {
      case 'ping':
        return send({ type: 'pong' });

      case 'host:create': {
        leave();
        const room = rooms.create();
        session = { role: 'host', room };
        send({ type: 'host:welcome', roomCode: room.code, hostToken: room.hostToken, lanUrl: lanUrl() });
        room.attachHost(socket);
        return;
      }

      case 'host:resume': {
        leave();
        const code = normalizeRoomCode(msg.roomCode);
        const room = code ? rooms.get(code) : undefined;
        if (!room || room.hostToken !== msg.hostToken) return fail('session-expired', 'That room has closed.');
        session = { role: 'host', room };
        send({ type: 'host:welcome', roomCode: room.code, hostToken: room.hostToken, lanUrl: lanUrl() });
        room.attachHost(socket);
        return;
      }

      case 'player:join': {
        leave();
        const code = normalizeRoomCode(msg.roomCode);
        const room = code ? rooms.get(code) : undefined;
        if (!room) return fail('room-not-found', 'No room with that code. Check the big screen.');
        const result = room.join(socket, typeof msg.name === 'string' ? msg.name : '');
        if (!result.ok) return fail(result.code, result.message);
        session = { role: 'player', room, playerId: result.player.info.id };
        send({ type: 'player:welcome', roomCode: room.code, playerId: result.player.info.id, token: result.player.token });
        send({ type: 'room', room: room.snapshot() });
        return;
      }

      case 'player:resume': {
        leave();
        const code = normalizeRoomCode(msg.roomCode);
        const room = code ? rooms.get(code) : undefined;
        if (!room) return fail('room-not-found', 'That room has closed.');
        const result = room.resume(socket, String(msg.playerId), String(msg.token));
        if (!result.ok) return fail(result.code, result.message);
        session = { role: 'player', room, playerId: result.player.info.id };
        send({ type: 'player:welcome', roomCode: room.code, playerId: result.player.info.id, token: result.player.token });
        send({ type: 'room', room: room.snapshot() });
        return;
      }

      case 'player:start': {
        if (session.role !== 'player') return fail('bad-request', 'Join a room first.');
        const err = session.room.startGame(session.playerId, String(msg.gameId));
        if (err) fail(err.code, err.message);
        return;
      }

      case 'player:lobby': {
        if (session.role !== 'player') return fail('bad-request', 'Join a room first.');
        const err = session.room.backToLobby(session.playerId);
        if (err) fail(err.code, err.message);
        return;
      }

      case 'player:input': {
        if (session.role !== 'player') return;
        session.room.input(session.playerId, msg.input);
        return;
      }

      default:
        return fail('bad-request', 'Unknown message type.');
    }
  });

  const leave = () => {
    if (session.role === 'host') session.room.detachHost(socket);
    else if (session.role === 'player') session.room.detachPlayer(socket);
    session = { role: 'none' };
  };

  socket.on('close', () => {
    clearInterval(heartbeat);
    leave();
  });
  socket.on('error', (err) => log(`socket error: ${String(err)}`));
});

function lanUrl(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return `http://${iface.address}:${PORT}`;
    }
  }
  return null;
}

http.listen(PORT, HOST, () => {
  log(`funfair server listening on http://${HOST}:${PORT}  (lan: ${lanUrl() ?? 'unknown'})`);
});

function shutdown() {
  log('shutting down');
  wss.close();
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
