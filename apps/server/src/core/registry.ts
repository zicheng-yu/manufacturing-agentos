import type { Domain } from '@agentos/shared';
import { HTTPException } from 'hono/http-exception';
import type { AgentDefinition, DomainModule, EventTypeDefinition } from './module.ts';

export class Registry {
  readonly modules: DomainModule[];
  readonly executiveAgents: AgentDefinition[];

  constructor(modules: DomainModule[], executiveAgents: AgentDefinition[]) {
    this.modules = modules;
    this.executiveAgents = executiveAgents;
    const ids = this.agents().map((a) => a.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) throw new Error(`Duplicate agent id: ${duplicate}`);
  }

  module(id: Domain): DomainModule {
    const found = this.modules.find((m) => m.id === id);
    if (!found) throw new HTTPException(404, { message: `未知模块：${id}` });
    return found;
  }

  hasModule(id: string): id is Domain {
    return this.modules.some((m) => m.id === id);
  }

  agents(): AgentDefinition[] {
    return [...this.executiveAgents, ...this.modules.flatMap((m) => m.agents)];
  }

  agent(id: string): AgentDefinition {
    const found = this.agents().find((a) => a.id === id);
    if (!found) throw new HTTPException(404, { message: `未知智能体：${id}` });
    return found;
  }

  eventType(domain: Domain, type: string): EventTypeDefinition | undefined {
    return this.module(domain).eventTypes.find((t) => t.type === type);
  }
}
