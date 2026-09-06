import type { GameClientDefinition } from '@funfair/shared/client';
import { whackMeta } from './meta';
import { mountWhackHost } from './host';
import { mountWhackController } from './controller';
import type { WhackHostState, WhackInput, WhackPlayerState } from './logic';
import './styles.css';

export const whackClient: GameClientDefinition<WhackHostState, WhackPlayerState, WhackInput> = {
  meta: whackMeta,
  mountHost: mountWhackHost,
  mountController: mountWhackController,
};
