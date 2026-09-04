import type { WebSocket } from 'ws';
import type {
  ErrorCode,
  GameInstance,
  GameResults,
  PlayerInfo,
  RoomPhase,
  RoomSnapshot,
  ServerMessage,
} from '@funfair/shared';
import { MAX_PLAYERS, PLAYER_AVATARS, PLAYER_COLORS, sanitizeName } from '@funfair/shared';
import { findServerGame, gameMetas } from '@funfair/games/server';
import { newId, newToken } from './codes';

const TICK_MS = 50;

interface PlayerRecord {
  info: PlayerInfo;
  token: string;
  socket: WebSocket | null;
}

export type JoinResult = { ok: true; player: PlayerRecord } | { ok: false; code: ErrorCode; message: string };

export class Room {
  readonly hostToken = newToken();
  hostSocket: WebSocket | null = null;
  phase: RoomPhase = 'lobby';
  results: GameResults | null = null;
  lastActivity = Date.now();

  private readonly players = new Map<string, PlayerRecord>();
  private game: { id: string; instance: GameInstance } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;

  constructor(
    readonly code: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  // ---- host ---------------------------------------------------------------

  attachHost(socket: WebSocket): void {
    this.touch();
    if (this.hostSocket && this.hostSocket !== socket) {
      this.hostSocket.close(4000, 'replaced');
    }
    this.hostSocket = socket;
    this.broadcastRoom();
    if (this.game) this.send(socket, { type: 'game:host', gameId: this.game.id, state: this.game.instance.hostState() });
  }

  detachHost(socket: WebSocket): void {
    if (this.hostSocket !== socket) return;
    this.hostSocket = null;
    this.broadcastRoom();
  }

  // ---- players ------------------------------------------------------------

  join(socket: WebSocket, rawName: string): JoinResult {
    this.touch();
    const name = sanitizeName(rawName);
    if (!name) return { ok: false, code: 'bad-name', message: 'Pick a name first.' };
    if (this.players.size >= MAX_PLAYERS) return { ok: false, code: 'room-full', message: 'That room is full.' };
    for (const p of this.players.values()) {
      if (p.info.name.toLowerCase() === name.toLowerCase()) {
        return { ok: false, code: 'name-taken', message: 'Someone in the room already has that name.' };
      }
    }
    const index = this.firstFreeSlot();
    const player: PlayerRecord = {
      info: {
        id: newId('p'),
        name,
        color: PLAYER_COLORS[index % PLAYER_COLORS.length]!,
        avatar: PLAYER_AVATARS[index % PLAYER_AVATARS.length]!,
        connected: true,
        isVip: this.players.size === 0,
      },
      token: newToken(),
      socket,
    };
    this.players.set(player.info.id, player);
    this.log(`${this.code}: ${name} joined (${this.players.size} players)`);
    this.broadcastRoom();
    return { ok: true, player };
  }

  resume(socket: WebSocket, playerId: string, token: string): JoinResult {
    const player = this.players.get(playerId);
    if (!player || player.token !== token) {
      return { ok: false, code: 'session-expired', message: 'That seat is no longer yours. Join again.' };
    }
    this.touch();
    if (player.socket && player.socket !== socket) player.socket.close(4000, 'replaced');
    player.socket = socket;
    player.info.connected = true;
    this.broadcastRoom();
    if (this.game) {
      this.send(socket, { type: 'game:player', gameId: this.game.id, state: this.game.instance.playerState(playerId) });
    }
    return { ok: true, player };
  }

  detachPlayer(socket: WebSocket): void {
    for (const p of this.players.values()) {
      if (p.socket === socket) {
        p.socket = null;
        p.info.connected = false;
        // In the lobby a disconnected player just leaves; mid-game we keep the seat for reconnects.
        if (this.phase === 'lobby') this.removePlayer(p.info.id);
        this.broadcastRoom();
        return;
      }
    }
  }

  playerFor(socket: WebSocket): PlayerRecord | undefined {
    for (const p of this.players.values()) if (p.socket === socket) return p;
    return undefined;
  }

  // ---- game lifecycle -----------------------------------------------------

  startGame(playerId: string, gameId: string): { code: ErrorCode; message: string } | null {
    const player = this.players.get(playerId);
    if (!player?.info.isVip) return { code: 'not-vip', message: 'Only the VIP can start a game.' };
    if (this.phase === 'playing') return { code: 'bad-request', message: 'A game is already running.' };
    const def = findServerGame(gameId);
    if (!def) return { code: 'game-not-found', message: 'Unknown game.' };
    const roster = [...this.players.values()].filter((p) => p.info.connected).map((p) => ({ ...p.info }));
    if (roster.length < def.meta.minPlayers) {
      return { code: 'not-enough-players', message: `${def.meta.name} needs at least ${def.meta.minPlayers} players.` };
    }
    this.touch();
    const instance = def.create({ players: roster, random: Math.random, now: () => performance.now() });
    this.game = { id: gameId, instance };
    this.results = null;
    this.phase = 'playing';
    this.log(`${this.code}: started ${gameId} with ${roster.length} players`);
    this.broadcastRoom();
    this.startLoop();
    return null;
  }

  backToLobby(playerId: string): { code: ErrorCode; message: string } | null {
    const player = this.players.get(playerId);
    if (!player?.info.isVip) return { code: 'not-vip', message: 'Only the VIP can do that.' };
    if (this.phase === 'playing') return { code: 'bad-request', message: 'Finish the game first.' };
    this.touch();
    this.phase = 'lobby';
    this.results = null;
    this.game = null;
    // Anyone who dropped mid-game and never came back is gone now.
    for (const p of [...this.players.values()]) if (!p.info.connected) this.removePlayer(p.info.id);
    this.broadcastRoom();
    return null;
  }

  input(playerId: string, input: unknown): void {
    if (!this.game || this.phase !== 'playing') return;
    this.touch();
    try {
      this.game.instance.onInput(playerId, input);
    } catch (err) {
      this.log(`${this.code}: game input error: ${String(err)}`);
    }
  }

  private startLoop(): void {
    this.stopLoop();
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.game) return this.stopLoop();
    const now = performance.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    try {
      this.game.instance.tick(dt);
      if (this.game.instance.isFinished()) {
        this.results = this.game.instance.results();
        this.phase = 'results';
        this.stopLoop();
        this.log(`${this.code}: ${this.game.id} finished`);
        this.broadcastRoom();
        return;
      }
      this.pushGameState();
    } catch (err) {
      this.log(`${this.code}: game crashed, returning to lobby: ${String(err)}`);
      this.game = null;
      this.phase = 'lobby';
      this.stopLoop();
      this.broadcastRoom();
    }
  }

  private pushGameState(): void {
    if (!this.game) return;
    const { id, instance } = this.game;
    if (this.hostSocket) this.send(this.hostSocket, { type: 'game:host', gameId: id, state: instance.hostState() });
    for (const p of this.players.values()) {
      if (p.socket) this.send(p.socket, { type: 'game:player', gameId: id, state: instance.playerState(p.info.id) });
    }
  }

  // ---- housekeeping -------------------------------------------------------

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      phase: this.phase,
      players: [...this.players.values()].map((p) => ({ ...p.info })),
      games: [...gameMetas],
      gameId: this.game?.id ?? null,
      results: this.results,
      hostConnected: this.hostSocket !== null,
    };
  }

  isIdle(): boolean {
    if (this.hostSocket) return false;
    for (const p of this.players.values()) if (p.socket) return false;
    return true;
  }

  destroy(): void {
    this.stopLoop();
    this.hostSocket?.close(4001, 'room closed');
    for (const p of this.players.values()) p.socket?.close(4001, 'room closed');
    this.players.clear();
  }

  private removePlayer(id: string): void {
    const wasVip = this.players.get(id)?.info.isVip;
    this.players.delete(id);
    if (wasVip) {
      const next = this.players.values().next().value as PlayerRecord | undefined;
      if (next) next.info.isVip = true;
    }
  }

  private firstFreeSlot(): number {
    const used = new Set([...this.players.values()].map((p) => PLAYER_COLORS.indexOf(p.info.color as (typeof PLAYER_COLORS)[number])));
    for (let i = 0; i < PLAYER_COLORS.length; i++) if (!used.has(i)) return i;
    return this.players.size;
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  private broadcastRoom(): void {
    const msg: ServerMessage = { type: 'room', room: this.snapshot() };
    if (this.hostSocket) this.send(this.hostSocket, msg);
    for (const p of this.players.values()) if (p.socket) this.send(p.socket, msg);
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }
}
