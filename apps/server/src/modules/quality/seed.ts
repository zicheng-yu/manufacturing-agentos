import type { EventInput } from '../../core/events.ts';
import type { ModuleCtx } from '../../core/module.ts';
import { addDays } from '../../core/util.ts';
import { qualityDate, shiftDate } from './calendar.ts';

// Demo data. Customer names are fictional.
const CASES = [
  [
    'QC-2024-017',
    '黑一下 黑屏 金手指 发黑 氧化 金手指氧化 接触不良',
    'FPC 金手指氧化导致接触不良',
    '12.3 英寸中控屏模组',
    'FPC 接触不良',
    '整车厂反馈间歇黑屏，拆解见 FPC 金手指发黑氧化，接触电阻偏高',
    '供应商出货未真空包装，来料仓湿度超过 70%RH 存放 9 天',
    '来料改真空包装并加湿度卡；来料仓湿度控制 ≤ 60%RH；上线前等离子清洗；IQC 增加金手指外观抽检',
    '昆山精联电子',
    -380,
  ],
  [
    'QC-2025-003',
    '发暗 暗角 亮度不均 一块暗 扩散膜褶皱 明暗不一',
    '背光扩散膜褶皱造成亮度不均',
    '12.3 英寸中控屏模组',
    '背光亮度不均',
    '点亮后局部发暗，亮度均匀性低于 80%',
    '背光模组扩散膜裁切后堆叠受压产生褶皱',
    '扩散膜改隔层包装；背光来料增加褶皱目检；组装前增加亮度均匀性测试',
    '常州明背光科技',
    -240,
  ],
  [
    'QC-2025-011',
    '起泡 鼓包 气泡 偏光片气泡 贴合气泡',
    '偏光片贴合气泡',
    '10.25 英寸仪表屏模组',
    '偏光片气泡',
    '低温或高湿环境后偏光片边缘起泡',
    '贴合压力参数漂移，脱泡釜保压时间不足',
    '贴合压力纳入 SPC 监控；脱泡保压时间由 20 分钟调整为 30 分钟',
    '宁波光膜材料',
    -150,
  ],
  [
    'QC-2025-020',
    '不亮 无显示 静电 ESD 击穿',
    '驱动 IC 静电损伤',
    '10.25 英寸仪表屏模组',
    '驱动 IC 失效',
    '上电后无显示，驱动 IC 引脚可见 ESD 击穿痕迹',
    '绑定工位离子风机失效，作业员腕带接地不良',
    '离子风机纳入日点检；腕带接地每班测试；增加 ESD 审核',
    '上海芯平半导体',
    -90,
  ],
  [
    'QC-2026-002',
    '触控失灵 点不动 触控无响应 溢胶',
    'OCA 溢胶导致触控失灵',
    '12.3 英寸中控屏模组',
    '触控失灵',
    '边缘区域触控无响应，拆解见 OCA 溢胶覆盖触控走线',
    'OCA 裁切尺寸公差偏大，贴合对位偏移',
    'OCA 裁切公差收紧至 ±0.1mm；贴合工位增加 CCD 对位检测',
    '宁波光膜材料',
    -40,
  ],
] as const;

export function seedQuality({ db, now }: ModuleCtx): void {
  const day = (n: number) => shiftDate(qualityDate(now), n);
  const insertCase = db.prepare(
    `INSERT INTO quality_cases (id, title, keywords, product, category, symptom, root_cause, countermeasure, supplier, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [id, keywords, title, product, category, symptom, root, counter, supplier, closed] of CASES) {
    insertCase.run(id, title, keywords, product, category, symptom, root, counter, supplier, day(closed));
  }

  const complaint = db.prepare(
    `INSERT INTO quality_complaints (id, customer, product, batch, symptom, category, severity, status, received_at, owner, case_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  complaint.run('CC-2609-21', '沪联新能源', '12.3 英寸中控屏模组', 'L1-2609-08', '亮度不均，局部发暗', '背光亮度不均', '一般', '已结案', day(-34), '品质经理', 'QC-2025-003');
  complaint.run('CC-2610-05', '苏越汽车', '10.25 英寸仪表屏模组', 'L2-2610-02', '低温测试后偏光片边缘起泡', '偏光片气泡', '一般', '处理中', day(-12), '品质经理', 'QC-2025-011');

  const capa = db.prepare('INSERT INTO quality_capa (id, complaint_id, title, owner, due, status) VALUES (?, ?, ?, ?, ?, ?)');
  capa.run('CAPA-029', 'CC-2609-21', '背光扩散膜来料增加褶皱检验', 'SQE 李工', day(-10), '已完成');
  capa.run('CAPA-031', 'CC-2610-05', '偏光片贴合压力参数纳入 SPC 监控', '工艺 王工', day(-1), '进行中');
  capa.run('CAPA-032', 'CC-2610-05', '脱泡保压时间验证报告', '工艺 王工', day(4), '进行中');
}

export function qualitySeedEvents(now: Date): EventInput[] {
  return [
    {
      domain: 'quality',
      type: 'customer_complaint',
      title: '江南智驾投诉中控屏冷启动闪屏',
      summary: '批次 L1-2610-11，冷启动时画面闪屏约 2 秒',
      payload: {
        complaintId: 'CC-2610-09',
        customer: '江南智驾',
        product: '12.3 英寸中控屏模组',
        batch: 'L1-2610-11',
        symptom: '冷启动时画面闪屏约 2 秒',
        category: '显示闪屏',
      },
      source: { channel: 'seed', actor: '客户服务' },
      at: addDays(now, -2),
    },
  ];
}
