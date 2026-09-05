/**
 * Browser-side game registry: host-screen and controller views for each game.
 */
import type { GameClientDefinition } from '@funfair/shared/client';
import { rollABallClient } from './roll-a-ball/client';
import { skeeBallClient } from './skee-ball/client';

export const clientGames: readonly GameClientDefinition<any, any, any>[] = [rollABallClient, skeeBallClient];

export function findClientGame(id: string): GameClientDefinition<any, any, any> | undefined {
  return clientGames.find((g) => g.meta.id === id);
}
