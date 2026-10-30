# 贡献指南

## 认领任务

1. 在 [Linear 项目](https://linear.app/youonlyattendonce/project/202610-11-达智汇-manufacturing-agentos-bcd830d231e4) 找到对应 issue，查看范围、验收条件和现有负责人。
2. **先将 issue Assign 给自己，并把状态设为 In Progress；确认负责人更新成功后，再开始开发。** 使用 AI 代理开发时，指派给发起开发的贡献者账号。已有负责人时先协调分工，不直接覆盖认领。
3. 一个 issue 一个分支，分支名包含 issue 编号。需要新任务时先在 Linear 建 issue 并认领。

## 开发与提交

- 按 [架构与协作约定](docs/architecture.md) 修改自己负责的模块，新增测试放在模块目录或 `apps/server/test/`。涉及平台核心、共享类型或其他模块时，在 PR 中说明原因。
- 只使用虚构业务数据；不提交真实员工、候选人、客户信息或 `.env`。
- 提交前运行 `npm test`、`npm run typecheck`；修改前端时再运行 `npm run build`。董事长演示主线必须保持通过。
- PR 标题带 Linear issue 编号，正文说明行为变化、验证结果及边界，并关联 issue。提交评审时更新为 In Review，合并且验收完成后再标记 Done。
