import { DOMAINS, type Domain, type Role } from '@agentos/shared';

const ROLE_DOMAINS: Record<Role, readonly Domain[]> = {
  executive: DOMAINS,
  production_mgr: ['production'],
  ehs_mgr: ['ehs'],
  supply_mgr: ['supply'],
  quality_mgr: ['quality'],
  hr_mgr: ['hr'],
  logistics_mgr: ['logistics'],
};

export function domainsFor(role: Role): Domain[] {
  return [...ROLE_DOMAINS[role]];
}

/** `executive` scope covers cross-domain agents such as the decision briefing. */
export function canSee(role: Role, scope: Domain | 'executive'): boolean {
  if (scope === 'executive') return role === 'executive';
  return ROLE_DOMAINS[role].includes(scope);
}

/** Service access grants no access to the owning module's other data or agents. */
export function canUseAgent(role: Role, agent: { module: Domain | 'executive'; companyService?: boolean }): boolean {
  return agent.companyService === true || canSee(role, agent.module);
}
