// "一颗螺丝的涟漪": the demo storyline, replayed through the simulation bridge by scripts/replay-demo.ts.
// The same steps drive the end-to-end test, so the demo cannot silently break.

export interface StoryStep {
  label: string;
  /** Pause before this step during a live replay. */
  delayMs: number;
  path: '/api/bridge/events' | '/api/modules/logistics/metrics';
  body: unknown;
}

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
  {
    label: '供应链部离职预警（1）',
    delayMs: 4000,
    path: '/api/bridge/events',
    body: {
      domain: 'hr',
      type: 'attrition_risk',
      channel: 'replay',
      title: '供应链部采购工程师离职预警',
      summary: '供应链部 1 名采购工程师提出离职意向',
      payload: { department: '供应链部', position: '采购工程师', employeeName: '陈某', reason: '收到外部 offer' },
    },
  },
  {
    label: '供应链部离职预警（2）',
    delayMs: 2500,
    path: '/api/bridge/events',
    body: {
      domain: 'hr',
      type: 'attrition_risk',
      channel: 'replay',
      title: '供应链部计划专员离职预警',
      summary: '供应链部 1 名计划专员提出离职意向',
      payload: { department: '供应链部', position: '计划专员', employeeName: '刘某', reason: '家庭原因异地发展' },
    },
  },
];
