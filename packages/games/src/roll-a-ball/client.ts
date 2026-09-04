import type { GameClientDefinition } from '@funfair/shared/client';
import { rollABallMeta } from './meta';
import { mountRollABallHost } from './host';
import { mountRollABallController } from './controller';
import type { RollABallHostState, RollABallInput, RollABallPlayerState } from './logic';
import './styles.css';

export const rollABallClient: GameClientDefinition<RollABallHostState, RollABallPlayerState, RollABallInput> = {
  meta: rollABallMeta,
  mountHost: mountRollABallHost,
  mountController: mountRollABallController,
};
