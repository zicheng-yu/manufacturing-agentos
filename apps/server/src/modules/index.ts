import { briefingAgent } from '../executive/briefing.ts';
import type { AgentDefinition, DomainModule } from '../core/module.ts';
import { ehsModule } from './ehs/index.ts';
import { hrModule } from './hr/index.ts';
import { logisticsModule } from './logistics/index.ts';
import { productionModule } from './production/index.ts';
import { qualityModule } from './quality/index.ts';
import { supplyModule } from './supply/index.ts';

/** Keep in the same order as DOMAINS in @agentos/shared. */
export const MODULES: DomainModule[] = [productionModule, supplyModule, qualityModule, logisticsModule, ehsModule, hrModule];

export const EXECUTIVE_AGENTS: AgentDefinition[] = [briefingAgent];
