import type { Company, Role } from '@agentos/shared';
import type { Dataset } from '../config.ts';

const DEMO_COMPANY: Company = {
  name: '达智汇科技服务（苏州）有限公司',
  shortName: '达智汇',
  tagline: '制造业智能体操作系统',
  demoNotice: '系统内业务数据均为演示数据，不代表企业实际经营情况',
};

/** The official pack describes an anonymised factory ("XXXX 制造有限公司") with precision machining, moulding and assembly. */
const OFFICIAL_COMPANY: Company = {
  name: 'XXXX 制造有限公司 · 赛道官方示例工厂',
  shortName: '达智汇',
  tagline: '制造业智能体操作系统',
  demoNotice: '业务数据与管理制度来自赛道官方素材包（仿真数据）',
};

export function companyFor(dataset: Dataset): Company {
  return dataset === 'official' ? OFFICIAL_COMPANY : DEMO_COMPANY;
}

/** Demo accounts. All share DEMO_PASSWORD (see .env.example). */
export const DEMO_ACCOUNTS: { username: string; displayName: string; role: Role; title: string }[] = [
  { username: 'chairman', displayName: '董事长', role: 'executive', title: '董事长' },
  { username: 'production', displayName: '生产经理', role: 'production_mgr', title: '生产部经理' },
  { username: 'ehs', displayName: '安环经理', role: 'ehs_mgr', title: '安环部经理' },
  { username: 'supply', displayName: '供应链经理', role: 'supply_mgr', title: '供应链部经理' },
  { username: 'quality', displayName: '品质经理', role: 'quality_mgr', title: '品质部经理' },
  { username: 'hr', displayName: 'HR 经理', role: 'hr_mgr', title: '人力资源部经理' },
  { username: 'logistics', displayName: '物流主管', role: 'logistics_mgr', title: '智能物流部主管' },
];
