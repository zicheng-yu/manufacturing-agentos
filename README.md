# 达智汇 Manufacturing AgentOS

达智汇「AI+智能制造」赛道参赛项目：一个覆盖供应链、品质、智能物流、HR 四个命题的制造业智能体平台。

- **身份解锁**：用什么岗位登录，就解锁什么模块、智能体与数据；董事长可见全部。
- **事件上卷**：一线事件（码垛失败、到货延迟、客诉、离职预警）按规则聚合为经理层信号，再汇总为董事长态势卡，信号可回溯到原始事件。
- **可信的智能体**：确定性分析（比价归一、案例检索、制度检索、库存天数）先算清楚，模型再撰写结论；事实、待核、建议分开，行动项进待办。
- **今日决策简报**：经营决策助手读取四个模块的态势，给出今天最需要决定的事，并指出跨部门关联。

系统内业务数据均为演示数据。

## 快速开始

需要 Node.js 22.13 及以上。

```bash
npm install
cp .env.example .env    # 填 LLM_API_KEY 后调用模型；留空则以离线规则模式运行
npm run dev             # 打开 http://localhost:5173
```

演示账号：`chairman`（董事长）、`supply`、`quality`、`logistics`、`hr`，密码为 `.env` 中的 `DEMO_PASSWORD`。

## 演示主线（董事长视角）

1. `npm run seed` 重置演示数据，`npm run dev` 启动，用 `chairman` 登录驾驶舱。
2. 另开终端 `npm run replay`：码垛-02 连续抓取失败 → 入库积压 → FPC 到货延迟导致缺料 → 客诉命中历史同类案例 → 供应链部离职预警。四张态势卡依次转为告警。
3. 点击「生成今日决策简报」：三件待决事项、负责人、时限，以及跨部门关联。
4. 进入「智能体工作台 → 寻源比价助手」，问「FPC 有没有替代货源？」，得到归一后的比价表。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PRD.md](docs/PRD.md) | 产品需求文档 |
| [docs/architecture.md](docs/architecture.md) | 架构、模块契约、怎么加功能、PR 约定 |
| [docs/event-bridge.md](docs/event-bridge.md) | 仿真事件桥协议（物流仿真对接） |
| [docs/competition.md](docs/competition.md) | 赛题四命题原文与待确认的赛事信息 |

## 协作

任务在 Linear 项目 [2026.10-11 达智汇 Manufacturing AgentOS](https://linear.app/youonlyattendonce/project/202610-11-达智汇-manufacturing-agentos-bcd830d231e4) 跟踪。**认领任务时，先在 Linear 将对应 issue Assign 给自己并设为 In Progress，确认负责人更新成功后再开始开发。** 已有负责人时先协调分工，避免重复开发。新功能按 issue 开分支、提 PR，合并前 `npm test` 与 `npm run typecheck` 必须通过。完整流程见 [贡献指南](CONTRIBUTING.md)。
