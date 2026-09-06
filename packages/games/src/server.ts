/**
 * Server-side game registry. Only pure logic lives behind this entry point –
 * nothing here may touch the DOM.
 */
import type { GameMeta, GameServerDefinition } from '@funfair/shared';
import { rollABallServer } from './roll-a-ball/server';
import { skeeBallServer } from './skee-ball/server';
import { hoopsServer } from './hoops/server';
import { whackServer } from './whack/server';

export const serverGames: readonly GameServerDefinition<any, any, any>[] = [rollABallServer, skeeBallServer, hoopsServer, whackServer];

export const gameMetas: readonly GameMeta[] = serverGames.map((g) => g.meta);

export function findServerGame(id: string): GameServerDefinition<any, any, any> | undefined {
  return serverGames.find((g) => g.meta.id === id);
}
