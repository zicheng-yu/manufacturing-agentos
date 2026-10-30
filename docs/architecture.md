# 架构与协作约定

这份文档给要往平台里加功能的人看：先读「核心概念」，再按「怎么加东西」改自己模块的目录，最后按「PR 约定」提交。

## 目录

```
apps/
  server/                 Node + Hono + SQLite（node:sqlite）
    src/
      core/               平台核心：鉴权、事件、信号、记忆、智能体运行时、事件桥
      modules/<id>/       四个领域模块，各自独立：index.ts（模块定义）、agents.ts、data.ts、seed.ts
      executive/          跨模块的经营决策助手（今日决策简报）
      seed/               公司信息、演示账号、演示主线 storyline.ts
    test/                 Vitest，含演示主线的端到端测试
  web/                    React + Vite + Tailwind
    src/pages/            驾驶舱、智能体工作台、模块页、事件中心、账号
packages/shared/          前后端共用的类型
scripts/replay-demo.ts    演示回放：把 storyline 通过事件桥逐步发给服务端
```

## 核心概念

### 模块（`DomainModule`）

每个领域（`supply` / `quality` / `logistics` / `hr`）是一个模块，定义在 `apps/server/src/modules/<id>/index.ts`，契约见 `core/module.ts`：

| 字段 | 作用 |
|---|---|
| `schema` / `seed` / `seedEvents` | 自己的数据表（表名以模块 id 开头）、演示数据、启动时注入的历史事件 |
| `agents` | 本模块的智能体 |
| `eventTypes` | 本模块允许的事件类型；`dedupeFields` 决定哪些重复事件合并，`hiddenFields` 决定哪些字段对哪些角色隐藏 |
| `signalRules` | 事件 → 信号的规则：时间窗、阈值、分组、给董事长的处置建议（`playbook`） |
| `situation()` | 驾驶舱上的态势卡 |
| `overview()` | 模块页的指标和表格 |
| `onEvent()` | 收到本模块事件时更新自己的表，必要时派生新事件（例如客诉命中历史案例 → 同类异常复发） |
| `routes()` | 额外接口，挂在 `/api/modules/<id>/` 下 |

核心代码不读模块的表，模块之间也不互相 import。跨模块的事情（例如决策简报里的跨部门关联）放在 `executive/`。

### 事件上卷

```
Event（一线）──规则──▶ Signal（经理）──汇总──▶ Situation（董事长）──▶ 今日决策简报
```

- `core/events.ts`：`ingestEvent()` 校验类型 → 去重合并（同一 dedupeKey 10 分钟内累加 count）→ 调模块 `onEvent()` → 重新计算信号与态势 → 通过 SSE 推送。
- `core/signals.ts`：按规则在时间窗内累加事件次数，达到阈值就产生信号，低于阈值或事件解决后自动清除。服务端每分钟也会重新计算一次。
- 信号可回溯：`GET /api/signals/:id` 返回构成它的原始事件。

### 智能体

一次问答 = 确定性分析 + 模型撰写：

1. `agent.context()` 读取模块数据，算出结论所需的事实、表格、行动项，必要时产生事件（例如缺料风险）。这一步不调用模型，结果可测试。
2. 配置了模型时，`core/agents/prompt.ts` 把分析结果、共享记忆和对话历史交给模型撰写正文；模型只补充新内容，不改写已算出的事实和行动项。没配置模型或模型失败时，直接用分析结果作答（离线规则模式）。
3. `core/agents/runtime.ts` 把事实 / 待核 / 建议写入共享记忆，行动项写入待办；删除一轮问答会连带删除它写入的记忆、待办和事件。

### 权限

`core/roles.ts`：角色 → 可见模块。智能体、事件、信号、记忆、待办、模块页都按模块判断可见性；董事长可见全部。

## 本地运行

```bash
npm install
cp .env.example .env      # 填 LLM_API_KEY 才会调用模型，否则为离线规则模式
npm run seed              # 重置演示数据（先停服务）
npm run dev               # 后端 :8787，前端 :5173
npm run replay            # 另开终端，回放演示主线；加 -- --fast 跳过停顿
npm test                  # 服务端测试
npm run typecheck
```

## 怎么加东西

- **加一个智能体**：在 `modules/<id>/agents.ts` 写一个 `AgentDefinition`，`context()` 里只放能算清楚的东西，加进模块的 `agents` 数组。给它写一个测试。
- **加一类事件**：在模块的 `eventTypes` 加定义；需要上卷就再加一条 `signalRules`，写清 `playbook`。事件桥会拒绝未定义的类型。
- **加模块数据**：在 `schema` 里建表（表名以模块 id 开头），在 `seed.ts` 写演示数据，在 `overview()` 里展示。
- **加接口**：在模块的 `routes()` 里注册，路径自动挂在 `/api/modules/<id>/` 下。需要鉴权时用 `requireScope(c, '<id>')`，给仿真用的用 `requireBridgeToken`。
- **改前端模块页**：通用模块页会渲染 `overview()` 返回的指标和表格；需要专门的页面时在 `apps/web/src/pages/` 新建，并在 `main.tsx` 注册路由。

## PR 约定

1. 一个 Linear issue 一个分支，分支名用 Linear 生成的 `zicheng/you-xxx-...`，PR 标题带 issue 编号。
2. 只改自己负责的目录：模块负责人改 `modules/<id>/`，物流仿真改 `modules/logistics/` 与仿真侧代码。需要动 `core/`、`packages/shared/` 或其他模块的，在 PR 里说明原因。
3. 合并前 `npm test` 与 `npm run typecheck` 必须通过；演示主线测试（`test/platform.test.ts` 的 demo storyline）不能被改坏。
4. 演示数据一律是虚构的；不要提交真实客户、员工信息，不要提交 `.env`。
