import type { PlayerInfo } from './protocol';

/** Static description of a game, shown in lobbies and used for validation. */
export interface GameMeta {
  id: string;
  name: string;
  tagline: string;
  minPlayers: number;
  maxPlayers: number;
}

/** What the server hands a game when it starts. */
export interface GameContext {
  players: PlayerInfo[];
  /** Deterministic-friendly random source (0..1). */
  random: () => number;
  /** Monotonic clock in milliseconds. */
  now: () => number;
}

export interface Standing {
  playerId: string;
  score: number;
  /** Human-readable score, e.g. "1st", "32 pts". */
  label: string;
}

export interface GameResults {
  /** Ordered best first. */
  standings: Standing[];
}

/**
 * A running game on the server. The room owns the lifecycle: it feeds inputs,
 * ticks the instance, forwards `hostState()` to the big screen and
 * `playerState(id)` to each phone, and collects `results()` once finished.
 */
export interface GameInstance<HostState = unknown, PlayerState = unknown, Input = unknown> {
  onInput(playerId: string, input: Input): void;
  tick(dtMs: number): void;
  hostState(): HostState;
  playerState(playerId: string): PlayerState;
  isFinished(): boolean;
  results(): GameResults;
}

export interface GameServerDefinition<HostState = unknown, PlayerState = unknown, Input = unknown> {
  meta: GameMeta;
  create(ctx: GameContext): GameInstance<HostState, PlayerState, Input>;
}
