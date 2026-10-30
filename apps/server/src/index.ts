import { serve } from '@hono/node-server';
import { createApp, createDeps } from './app.ts';
import { loadConfig } from './config.ts';
import { evaluateDomain } from './core/signals.ts';
import { isSeeded, seedAll } from './seed/index.ts';

const config = loadConfig();
const deps = createDeps(config);
if (!isSeeded(deps)) {
  seedAll(deps);
  console.log('已写入演示数据');
}

// Signals have time windows; re-evaluate periodically so they clear even without new events.
setInterval(() => {
  for (const module of deps.registry.modules) evaluateDomain(deps, module.id);
}, 60_000).unref();

serve({ fetch: createApp(deps).fetch, port: config.port }, (info) => {
  console.log(`AgentOS 服务已启动：http://localhost:${info.port}`);
  console.log(`模型：${deps.provider.mode === 'llm' ? deps.provider.model : '未配置（离线规则模式）'}`);
  console.log(`事件桥：${config.bridgeToken ? '已启用' : '未启用（未设置 BRIDGE_TOKEN）'}`);
});
