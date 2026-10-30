import { DOMAINS, type Domain, type Role } from '@agentos/shared';

const ROLE_DOMAINS: Record<Role, readonly Domain[]> = {
  executive: DOMAINS,
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
