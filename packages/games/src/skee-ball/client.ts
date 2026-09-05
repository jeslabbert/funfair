import type { GameClientDefinition } from '@funfair/shared/client';
import { skeeBallMeta } from './meta';
import { mountSkeeBallHost } from './host';
import { mountSkeeBallController } from './controller';
import type { SkeeBallHostState, SkeeBallInput, SkeeBallPlayerState } from './logic';
import './styles.css';

export const skeeBallClient: GameClientDefinition<SkeeBallHostState, SkeeBallPlayerState, SkeeBallInput> = {
  meta: skeeBallMeta,
  mountHost: mountSkeeBallHost,
  mountController: mountSkeeBallController,
};
