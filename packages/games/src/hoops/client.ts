import type { GameClientDefinition } from '@funfair/shared/client';
import { hoopsMeta } from './meta';
import { mountHoopsHost } from './host';
import { mountHoopsController } from './controller';
import type { HoopsHostState, HoopsInput, HoopsPlayerState } from './logic';
import './styles.css';

export const hoopsClient: GameClientDefinition<HoopsHostState, HoopsPlayerState, HoopsInput> = {
  meta: hoopsMeta,
  mountHost: mountHoopsHost,
  mountController: mountHoopsController,
};
