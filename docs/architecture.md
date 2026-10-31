# 架构与协作约定

这份文档给要往平台里加功能的人看：先读「核心概念」，再按「怎么加东西」改自己模块的目录，最后按「PR 约定」提交。

## 目录

```
apps/
  server/                 Node + Hono + SQLite（node:sqlite）
    src/
      core/               平台核心：鉴权、事件、信号、记忆、智能体运行时、事件桥
      modules/<id>/       六个领域模块，各自独立：index.ts（模块定义）、agents.ts、data.ts、seed.ts；official.ts 接官方素材包
      executive/          跨模块的经营决策助手（今日决策简报）
      seed/               公司信息、演示账号、演示主线 storyline.ts、官方素材包读取 official.ts
    test/                 Vitest，含演示主线的端到端测试
  web/                    React + Vite + Tailwind
    src/pages/            驾驶舱、智能体工作台、模块页、事件中心、账号
packages/shared/          前后端共用的类型
data/official/            赛道官方素材包：tables/*.csv 业务表、policies.json 管理制度条款
scripts/replay-demo.ts    演示回放：把 storyline 通过事件桥逐步发给服务端
scripts/convert-official-pack.py  把素材包的 xlsx 与 PDF 制度转换成 data/official/
```

## 核心概念

### 模块（`DomainModule`）

每个领域（`production` / `supply` / `quality` / `logistics` / `ehs` / `hr`）是一个模块，定义在 `apps/server/src/modules/<id>/index.ts`，契约见 `core/module.ts`：

| 字段 | 作用 |
|---|---|
| `schema` / `migrate` / `seed` / `seedEvents` | 自己的数据表（表名以模块 id 开头）、给已有库补列、按数据集（`official` / `demo`）写入数据、启动时注入的历史事件 |
| `beforeEvaluate()` | 计算信号前，把由数据决定的业务状态（缺料、OEE 低于目标、AGV 按时率等）同步成状态事件，见 `core/state-alerts.ts` |
| `agents` | 本模块的智能体 |
| `eventTypes` | 本模块允许的事件类型；`dedupeFields` 决定哪些重复事件合并，`hiddenFields` 决定哪些字段对哪些角色隐藏 |
| `signalRules` | 事件 → 信号的规则：时间窗、阈值、分组、给董事长的处置建议（`playbook`） |
| `situation()` | 驾驶舱上的态势卡 |
| `overview()` | 模块页的指标和表格 |
| `onEvent()` | 收到本模块事件时更新自己的表，必要时派生新事件（例如客诉命中历史案例 → 同类异常复发） |
| `routes()` | 额外接口，挂在 `/api/modules/<id>/` 下 |

核心代码不读模块的表，模块之间也不互相 import。跨模块的事情（例如决策简报里的跨部门关联）放在 `executive/`：事件 `payload` 里的 `materialCode`、`supplierName`、`causes`（停机原因，如「缺料待料」「品质异常」）相同的信号会被关联起来。

### 事件上卷

```
Event（一线）──规则──▶ Signal（经理）──汇总──▶ Situation（董事长）──▶ 今日决策简报
```

- `core/events.ts`：`ingestEvent()` 校验类型 → 去重合并（同一 dedupeKey 10 分钟内累加 count）→ 调模块 `onEvent()` → 重新计算信号与态势 → 通过 SSE 推送。
- `core/signals.ts`：按规则在时间窗内累加事件次数，达到阈值就产生信号，低于阈值或事件解决后自动清除。服务端每分钟也会重新计算一次。
- 信号可回溯：`GET /api/signals/:id` 返回构成它的原始事件。

### 智能体

一次问答 = 确定性分析 + 模型撰写：

1. `agent.context()` 读取模块数据，算出结论所需的事实、表格、行动项，必要时产生事件（例如缺料风险）。默认使用确定性规则；公司制度助手可在此调用模型选择原文条款，核验引用后返回 `preparedResponse`。
2. 配置了模型时，`core/agents/prompt.ts` 把分析结果、共享记忆和对话历史交给模型撰写正文；模型只补充新内容，不改写已算出的事实和行动项。没配置模型或模型失败时，直接用分析结果作答（离线规则模式）。
3. `core/agents/runtime.ts` 把事实 / 待核 / 建议写入共享记忆，行动项写入待办；删除一轮问答会连带删除它写入的记忆、待办和事件。

### 权限

`core/roles.ts`：角色 → 可见模块。事件、信号、记忆、待办、模块页按模块判断可见性；董事长可见全部。智能体默认沿用模块权限；显式声明 `companyService` 的员工自助助手可由所有已登录账号调用，不开放所属模块的管理数据。当前只有 `hr.service` 使用此标记，员工自助请求仍按账号隔离。

领域助手可使用异步 `context()` 完成检索与验证，并返回 `preparedResponse` 跳过通用模型撰写。公司制度助手借此核对引用的有效版本和原文后保存回答，其余助手沿用原流程。

## 本地运行

```bash
npm install
cp -n .env.example .env   # 首次创建；填 LLM_API_KEY 才会调用模型，否则为离线规则模式
npm run seed              # 重置演示数据（先停服务）
npm run dev               # 后端 :8787，前端 :5173
npm run replay            # 另开终端，回放演示主线；加 -- --fast 跳过停顿
npm test                  # 服务端测试（demo 数据集 + test/official.test.ts 的官方数据集）
npm run typecheck
```

## 怎么加东西

- **加一个智能体**：在 `modules/<id>/agents.ts` 写一个 `AgentDefinition`，`context()` 里只放能算清楚的东西，加进模块的 `agents` 数组。给它写一个测试。
- **加一类事件**：在模块的 `eventTypes` 加定义；需要上卷就再加一条 `signalRules`，写清 `playbook`。事件桥会拒绝未定义的类型。
- **加模块数据**：在 `schema` 里建表（表名以模块 id 开头），在 `seed.ts` 写演示数据，在 `overview()` 里展示。官方素材包的表用 `seed/official.ts` 的 `officialTable()` 读取，引用制度条款用 `cite('SCM-2025-001-5.2')`，不要手写条款内容。
- **加接口**：在模块的 `routes()` 里注册，路径自动挂在 `/api/modules/<id>/` 下。需要鉴权时用 `requireScope(c, '<id>')`，给仿真用的用 `requireBridgeToken`。
- **改前端模块页**：通用模块页会渲染 `overview()` 返回的指标和表格；需要专门的页面时在 `apps/web/src/pages/` 新建，并在 `main.tsx` 注册路由。

## 前端视觉

钢构工业风：钢蓝墨 `#0E1726` 侧栏与表头、水泥灰底、工业蓝 `#1D5BD6` 主操作，告警红 / 关注琥珀靠明暗区分；读数用 Barlow Condensed，编号与时间用 JetBrains Mono（随包自带，不依赖外网字体）；分区标题统一用 `Section`（编号 + 中文 + 英文标签），告警卡片顶边是警示斜纹。色值在 `apps/web/src/index.css` 的 `@theme` 里。

照片位：驾驶舱横幅读 `apps/web/public/photos/hero.jpg`，登录页读 `login.jpg`，模块页读 `<模块 id>.jpg`（如 `production.jpg`）。文件不存在时显示斜纹占位，照片上的文字都压在深色底上，换任何照片都可读。只放有使用授权的现场实拍，并在 PR 里写明来源。

## PR 约定

1. **先认领，再开发**：在 Linear 把对应 issue Assign 给自己、状态改为 In Progress，确认保存成功后再开分支写代码；已有负责人时先协调。一个 issue 一个分支，分支名带 issue 编号（如 `codex/you-124-hr-workflows` 或 Linear 生成的分支名），PR 标题带 issue 编号。完整流程见 [贡献指南](../CONTRIBUTING.md)。
2. 只改自己负责的目录：模块负责人改 `modules/<id>/`，物流仿真改 `modules/logistics/` 与仿真侧代码。需要动 `core/`、`packages/shared/` 或其他模块的，在 PR 里说明原因。
3. 合并前 `npm test` 与 `npm run typecheck` 必须通过；两条演示主线测试（`test/platform.test.ts` 的 demo storyline、`test/official.test.ts` 的线束03 主线）不能被改坏。
4. 业务数据只用官方素材包或虚构数据；不要提交真实客户、员工信息，不要提交 `.env`。
