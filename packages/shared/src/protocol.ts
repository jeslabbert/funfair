import type { GameMeta, GameResults } from './game';

export type PlayerId = string;
export type RoomPhase = 'lobby' | 'playing' | 'results';

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  color: string;
  avatar: string;
  connected: boolean;
  /** The VIP (first player to join) controls starting games. */
  isVip: boolean;
}

export interface RoomSnapshot {
  code: string;
  phase: RoomPhase;
  players: PlayerInfo[];
  games: GameMeta[];
  gameId: string | null;
  results: GameResults | null;
  hostConnected: boolean;
}

export type ErrorCode =
  | 'room-not-found'
  | 'room-full'
  | 'bad-name'
  | 'name-taken'
  | 'not-vip'
  | 'bad-request'
  | 'game-not-found'
  | 'not-enough-players'
  | 'session-expired';

/** Messages a browser sends to the server. */
export type ClientMessage =
  | { type: 'host:create' }
  | { type: 'host:resume'; roomCode: string; hostToken: string }
  | { type: 'player:join'; roomCode: string; name: string }
  | { type: 'player:resume'; roomCode: string; playerId: string; token: string }
  | { type: 'player:start'; gameId: string }
  | { type: 'player:lobby' }
  | { type: 'player:input'; input: unknown }
  | { type: 'ping' };

/** Messages the server sends to a browser. */
export type ServerMessage =
  | { type: 'host:welcome'; roomCode: string; hostToken: string; lanUrl: string | null }
  | { type: 'player:welcome'; roomCode: string; playerId: string; token: string }
  | { type: 'room'; room: RoomSnapshot }
  | { type: 'game:host'; gameId: string; state: unknown }
  | { type: 'game:player'; gameId: string; state: unknown }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'pong' };
