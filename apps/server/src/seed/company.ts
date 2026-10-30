import type { Company, Role } from '@agentos/shared';

export const COMPANY: Company = {
  name: '达智汇科技服务（苏州）有限公司',
  shortName: '达智汇',
  tagline: '制造业智能体操作系统',
  demoNotice: '系统内业务数据均为演示数据，不代表企业实际经营情况',
};

/** Demo accounts. All share DEMO_PASSWORD (see .env.example). */
export const DEMO_ACCOUNTS: { username: string; displayName: string; role: Role; title: string }[] = [
  { username: 'chairman', displayName: '董事长', role: 'executive', title: '董事长' },
  { username: 'supply', displayName: '供应链经理', role: 'supply_mgr', title: '供应链部经理' },
  { username: 'quality', displayName: '品质经理', role: 'quality_mgr', title: '品质部经理' },
  { username: 'hr', displayName: 'HR 经理', role: 'hr_mgr', title: '人力资源部经理' },
  { username: 'logistics', displayName: '物流主管', role: 'logistics_mgr', title: '智能物流部主管' },
];
