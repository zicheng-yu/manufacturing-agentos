import { briefingAgent } from '../executive/briefing.ts';
import type { AgentDefinition, DomainModule } from '../core/module.ts';
import { hrModule } from './hr/index.ts';
import { logisticsModule } from './logistics/index.ts';
import { qualityModule } from './quality/index.ts';
import { supplyModule } from './supply/index.ts';

/** Keep in the same order as DOMAINS in @agentos/shared. */
export const MODULES: DomainModule[] = [supplyModule, qualityModule, logisticsModule, hrModule];

export const EXECUTIVE_AGENTS: AgentDefinition[] = [briefingAgent];
