// Demo storylines replayed through the simulation bridge by scripts/replay-demo.ts: "一颗螺丝的涟漪" on the fictional
// fixtures and "线束03 的连锁反应" on the official pack. The same steps drive the end-to-end tests, so neither can
// silently break.
import type { Dataset } from '../config.ts';

export interface StoryStep {
  label: string;
  /** Pause before this step during a live replay. */
  delayMs: number;
  path: '/api/bridge/events' | '/api/modules/logistics/metrics' | '/api/modules/production/readings';
  body: unknown;
}

const attrition = (position: string, employeeName: string, reason: string) => ({
  domain: 'hr',
  type: 'attrition_risk',
  channel: 'replay',
  title: `供应链部${position}离职预警`,
  summary: `供应链部 1 名${position}提出离职意向`,
  payload: { department: '供应链部', position, employeeName, reason },
});

const grasp = (attempt: number) => ({
  domain: 'logistics',
  type: 'grasp_failed',
  station: '码垛-02',
  channel: 'replay',
  title: '码垛-02 抓取失败',
  summary: `夹爪真空度不足，KLT-6414 料箱第 ${attempt} 次抓取脱落`,
  payload: { binType: 'KLT-6414', attempt, vacuumKpa: -38 },
});

export const STORYLINE: StoryStep[] = [
  { label: '码垛-02 第 1 次抓取失败', delayMs: 2000, path: '/api/bridge/events', body: grasp(1) },
  { label: '码垛-02 第 2 次抓取失败', delayMs: 2500, path: '/api/bridge/events', body: grasp(2) },
  { label: '码垛-02 第 3 次抓取失败', delayMs: 2500, path: '/api/bridge/events', body: grasp(3) },
  {
    label: '工位指标：码垛-02 降速，暂存区积压',
    delayMs: 1500,
    path: '/api/modules/logistics/metrics',
    body: [
      { station: '码垛-02', picks: 12, pickFailures: 3, placements: 9, placementInvalid: 0, cycleTimeS: 19.5 },
      { station: '入库暂存区', backlog: 46 },
    ],
  },
  {
    label: '入库暂存区积压',
    delayMs: 2500,
    path: '/api/bridge/events',
    body: {
      domain: 'logistics',
      type: 'backlog_high',
      station: '入库暂存区',
      channel: 'replay',
      title: '入库暂存区积压 46 箱',
      summary: '码垛-02 降速后暂存区积压 46 箱，其中 FPC-1203 料箱 12 箱未上架',
      payload: { backlog: 46, materialCode: 'FPC-1203', bins: 12 },
    },
  },
  {
    label: 'FPC 供应商到货延迟',
    delayMs: 4000,
    path: '/api/bridge/events',
    body: {
      domain: 'supply',
      type: 'inbound_delay',
      channel: 'replay',
      title: 'PO-2611 FPC 柔性电路板到货延迟 3 天',
      summary: '昆山精联电子反馈电镀线检修，PO-2611 顺延 3 天',
      payload: { orderId: 'PO-2611', materialCode: 'FPC-1203', supplierId: 'SUP-JL', supplierName: '昆山精联电子', delayDays: 3 },
    },
  },
  {
    label: '客户投诉 FPC 金手指氧化',
    delayMs: 4000,
    path: '/api/bridge/events',
    body: {
      domain: 'quality',
      type: 'customer_complaint',
      channel: 'replay',
      title: '苏越汽车投诉中控屏间歇黑屏',
      summary: '批次 L1-2610-19，拆解见 FPC 金手指发黑氧化',
      payload: {
        complaintId: 'CC-2610-12',
        customer: '苏越汽车',
        product: '12.3 英寸中控屏模组',
        batch: 'L1-2610-19',
        symptom: '屏幕间歇黑屏，拆解见 FPC 金手指发黑氧化',
        category: 'FPC 接触不良',
        materialCode: 'FPC-1203',
      },
    },
  },
  { label: '供应链部离职预警（1）', delayMs: 4000, path: '/api/bridge/events', body: attrition('采购工程师', '陈某', '收到外部 offer') },
  { label: '供应链部离职预警（2）', delayMs: 2500, path: '/api/bridge/events', body: attrition('计划专员', '刘某', '家庭原因异地发展') },
];

const vibration = (...values: number[]) => values.map((v) => ({ equipmentId: 'EQ-IM-012', vibration: v, temperature: 58 + v * 2 }));

const agvTimeout = (taskId: string, waitS: number) => ({
  domain: 'logistics',
  type: 'agv_task_timeout',
  station: 'AGV-02',
  channel: 'replay',
  title: `${taskId} 线束03 配送超时`,
  summary: `AGV-02 原料仓 → 线边库A 送 M-10003 线束03，路口等待 ${waitS} 秒后超时`,
  payload: { taskId, agv: 'AGV-02', origin: '原料仓', dest: '线边库A', materialCode: 'M-10003', waitS, causes: ['缺料待料'] },
});

/** "线束03 的连锁反应": an injection press drifts toward failure while the harness that is already short arrives late. */
export const OFFICIAL_STORYLINE: StoryStep[] = [
  { label: 'EQ-IM-012 注塑机振动上升', delayMs: 2000, path: '/api/modules/production/readings', body: vibration(2.4, 2.9, 3.1) },
  { label: 'EQ-IM-012 出现故障前兆', delayMs: 3000, path: '/api/modules/production/readings', body: vibration(3.4) },
  { label: 'AGV-02 送线束03 超时', delayMs: 3000, path: '/api/bridge/events', body: agvTimeout('AGV-T6201', 240) },
  { label: 'AGV-02 再次超时', delayMs: 2500, path: '/api/bridge/events', body: agvTimeout('AGV-T6205', 310) },
  {
    label: '苏州精工科技交付风险',
    delayMs: 4000,
    path: '/api/bridge/events',
    body: {
      domain: 'supply',
      type: 'supplier_risk',
      channel: 'replay',
      title: '苏州精工科技线束交付能力下降',
      summary: '供应商反馈端子压接设备检修，未来两周 M-10003 线束03 交付能力下降约 30%',
      payload: { supplierId: 'SUP-01', supplierName: '苏州精工科技', materialCode: 'M-10003' },
    },
  },
  { label: 'EQ-IM-012 振动超限', delayMs: 4000, path: '/api/modules/production/readings', body: vibration(4.9) },
  { label: '供应链部离职预警（1）', delayMs: 4000, path: '/api/bridge/events', body: attrition('采购工程师', '陈某', '收到外部 offer') },
  { label: '供应链部离职预警（2）', delayMs: 2500, path: '/api/bridge/events', body: attrition('计划专员', '刘某', '家庭原因异地发展') },
];

export const storylineFor = (dataset: Dataset): StoryStep[] => (dataset === 'official' ? OFFICIAL_STORYLINE : STORYLINE);
