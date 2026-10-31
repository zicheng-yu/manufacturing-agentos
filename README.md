# 达智汇 Manufacturing AgentOS

达智汇（ADTTech，原名友达数位）「AI+智能制造」赛道参赛项目：一个制造业智能体平台，结构上对应达智汇 DARL 的指标、感知、决策、执行四张网（见 [PRD 第 13 节](docs/PRD.md)）。在赛题的供应链、品质、智能物流、HR 四个命题之外，按赛道官方素材包扩展了生产设备与能源安全两个模块。

- **身份解锁**：用什么岗位登录，就解锁什么模块、智能体与数据；董事长可见全部。
- **事件上卷**：一线事件（设备振动、AGV 超时、到货延迟、致命不良、安全违规、离职预警）按规则聚合为经理层信号，再汇总为董事长态势卡，信号可回溯到原始事件。
- **可信的智能体**：确定性分析（供应商评分、审批路径、故障前兆、排产方案、AOI 漏检、制度检索）先算清楚，模型再撰写结论；结论引用官方管理制度的条款，事实、待核、建议分开，行动项进待办。
- **今日决策简报**：经营决策助手读取各模块的态势，给出今天最需要决定的事，并按共同的物料、供应商和停机原因指出跨部门关联。

## 数据

默认使用赛道官方素材包（`data/official/`，仿真数据）：16 张业务表与 4 份管理制度（HR / 供应链 / 品质 / 智能物流，共 199 个条款）。素材包更新后用 `scripts/convert-official-pack.py` 重新转换。`.env` 设 `DATASET=demo` 可切回自带的虚构演示数据，测试默认使用后者。

## 快速开始

需要 Node.js 22.13 及以上。

```bash
npm install
cp -n .env.example .env # 首次创建；填 LLM_API_KEY 后调用模型，留空则以离线规则模式运行
npm run dev             # 打开 http://localhost:5173
```

演示账号：`chairman`（董事长）、`production`、`supply`、`quality`、`logistics`、`ehs`、`hr`，密码为 `.env` 中的 `DEMO_PASSWORD`。

## 演示主线（董事长视角）

1. `npm run seed` 重置演示数据，`npm run dev` 启动，用 `chairman` 登录驾驶舱。
2. 驾驶舱直接呈现素材包里的问题：线束03（M-10003）约 3 天后断料、4 张工单预计延期、8 单致命不良未开 8D、AGV 按时率 83.7%、30 起高风险违规未闭环。
3. 另开终端 `npm run replay`（完整流程与话术见[演示手册](docs/demo.md)），回放「线束03 的连锁反应」：注塑机 EQ-IM-012 振动进入故障前兆区 → AGV-02 送线束03 连续超时 → 苏州精工科技交付能力下降 → 振动超限 → 供应链部离职预警。
4. 点击「生成今日决策简报」：三件待决事项、负责人、时限，以及「缺料待料」把供应链、物流和生产串起来的跨部门关联。
5. 进入「智能体工作台 → 寻源比价助手」，问「线束快断货了，几家供应商怎么选？」，得到按《供应链管理制度》5.2 计算的供应商评分和 4.1 的审批路径。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/demo.md](docs/demo.md) | 演示手册：在自己电脑上跑起来并完成演示 |
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/architecture.md](docs/architecture.md) | 架构、模块契约、怎么加功能、PR 约定 |
| [docs/event-bridge.md](docs/event-bridge.md) | 事件桥协议：外部系统上报事件与设备读数 |
| [docs/competition.md](docs/competition.md) | 赛题四命题原文与待确认的赛事信息 |

## 协作

任务在 Linear 项目 [2026.10-11 达智汇 Manufacturing AgentOS](https://linear.app/youonlyattendonce/project/202610-11-达智汇-manufacturing-agentos-bcd830d231e4) 跟踪。**认领任务时，先在 Linear 将对应 issue Assign 给自己并设为 In Progress，确认负责人更新成功后再开始开发。** 已有负责人时先协调分工，避免重复开发。新功能按 issue 开分支、提 PR，合并前 `npm test` 与 `npm run typecheck` 必须通过。完整流程见 [贡献指南](CONTRIBUTING.md)。
