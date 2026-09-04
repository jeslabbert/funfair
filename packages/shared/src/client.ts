/**
 * Browser-only contracts. Imported via `@funfair/shared/client` so the server
 * never has to know about the DOM.
 */
import type { PlayerInfo } from './protocol';
import type { GameMeta } from './game';

/** Host-screen view for a game. Mounted into a container and fed state updates. */
export interface HostView<HostState = unknown> {
  update(state: HostState, players: PlayerInfo[]): void;
  destroy(): void;
}

/** Phone controller view for a game. */
export interface ControllerView<PlayerState = unknown> {
  update(state: PlayerState, me: PlayerInfo, players: PlayerInfo[]): void;
  destroy(): void;
}

export interface GameClientDefinition<HostState = unknown, PlayerState = unknown, Input = unknown> {
  meta: GameMeta;
  mountHost(root: HTMLElement): HostView<HostState>;
  mountController(root: HTMLElement, send: (input: Input) => void): ControllerView<PlayerState>;
}
