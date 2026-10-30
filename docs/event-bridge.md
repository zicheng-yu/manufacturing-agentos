# 仿真事件桥协议

仿真侧（机器人控制程序、设备采集、AGV 调度系统）通过 HTTP 把识别、抓取、码垛的结果、设备读数和异常上报到平台。平台据此更新现场看板、产生信号，并上卷到董事长驾驶舱。

## 鉴权

所有请求带请求头 `X-Bridge-Token`，值与服务端 `.env` 中的 `BRIDGE_TOKEN` 一致。服务端未设置时事件桥返回 503。

## 上报事件：`POST /api/bridge/events`

请求体是一个事件或事件数组（最多 200 个）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | 事件类型，见下表 |
| `domain` | 否 | 默认 `logistics` |
| `station` | 建议 | 工位，必须与看板工位一致：`识别-01`、`抓取-01`、`码垛-01`、`码垛-02`、`入库暂存区` |
| `title` / `summary` | 否 | 不填时按工位和类型生成标题 |
| `severity` | 否 | `info` / `warn` / `critical`，默认取类型的默认级别 |
| `payload` | 否 | 任意 JSON，例如料箱规格、尝试次数、真空度、物料编码 `materialCode` |
| `count` | 否 | 本条代表的次数，批量上报时用 |
| `occurredAt` | 否 | ISO 时间，默认服务端当前时间 |
| `channel` | 否 | `bridge`（默认）或 `replay` |

### 物流事件类型

| type | 含义 | 默认级别 | 上卷规则 |
|---|---|---|---|
| `recognition_failed` | 料箱识别失败 | warn | 同一工位 30 分钟内 ≥ 3 次 → 「料箱识别异常」 |
| `grasp_failed` | 抓取失败 | warn | 同一工位 30 分钟内 ≥ 3 次 → 「抓取连续失败」（严重） |
| `placement_invalid` | 放置检查不通过 | warn | 同一工位 30 分钟内 ≥ 2 次 → 「放置不合规」 |
| `backlog_high` | 入库积压 | warn | 60 分钟内出现即告警 |
| `station_down` | 工位停机 | critical | 出现即告警，工位状态改为停机 |
| `agv_task_timeout` | AGV 任务超时，`payload` 带 `taskId`、`agv`、`origin`、`dest`、`materialCode` | warn | 同一台 AGV 120 分钟内 ≥ 2 单 → 「配送连续超时」 |

同一工位、同一类型的未解决事件在 10 分钟内重复上报会合并为一条并累加次数，不会刷屏。`payload.materialCode` 会参与驾驶舱的跨部门关联（例如积压的料箱属于正在缺料的物料）。

示例：

```bash
curl -X POST http://localhost:8787/api/bridge/events \
  -H 'Content-Type: application/json' -H "X-Bridge-Token: $BRIDGE_TOKEN" \
  -d '{"type":"grasp_failed","station":"码垛-02","summary":"夹爪真空度不足，KLT-6414 料箱脱落","payload":{"binType":"KLT-6414","vacuumKpa":-38}}'
```

返回：`{"events":[{"id":"EVT-…","created":true,"count":1}]}`。类型未定义时返回 400。

## 上报工位指标：`POST /api/modules/logistics/metrics`

周期性计数（建议每 1–5 分钟一次），用于看板的成功率、合规率、节拍与积压。请求体是一条或一个数组。

| 字段 | 说明 |
|---|---|
| `station` | 工位（同上，未知工位返回 400） |
| `ts` | ISO 时间，默认当前 |
| `recognitions` / `recognitionFailures` | 本周期识别次数 / 失败次数 |
| `picks` / `pickFailures` | 本周期抓取次数 / 失败次数 |
| `placements` / `placementInvalid` | 本周期码放次数 / 不合规次数 |
| `cycleTimeS` | 平均节拍（秒） |
| `backlog` | 当前积压箱数（取最新一次） |

## 上报设备读数：`POST /api/modules/production/readings`

设备采集或仿真按小时（或更密）上报主轴读数，一条或一个数组（最多 500 条）。设备编号必须在官方素材包的设备主数据里（如 `EQ-IM-012`），未知设备返回 400。

| 字段 | 说明 |
|---|---|
| `equipmentId` | 设备编号 |
| `ts` | ISO 时间，默认当前 |
| `vibration` | 主轴振动 RMS（mm/s） |
| `temperature` / `current` / `rpm` / `load` | 主轴温度、电流、转速、负载率，可选 |

24 小时内 ≥ 3 次读数达到 2.8 mm/s 记为「故障前兆」（警告）；任一读数达到 4.5 mm/s 记为「振动超限」（严重）。阈值来自素材包的历史故障：设备进入 2.8 mm/s 关注区后平均约 33 小时发生故障。

## 料箱规格与码垛规则

| 规格 | 尺寸(mm) | 最大堆叠层数 | 目标区域 |
|---|---|---|---|
| KLT-4314 | 400×300×147 | 6 | A 区 |
| KLT-6414 | 600×400×147 | 5 | B 区 |
| KLT-6428 | 600×400×280 | 3 | C 区 |
| GLT-1208 | 1200×800×600 | 2 | D 区 |

规则以 `apps/server/src/modules/logistics/seed.ts` 为准；仿真侧的规格或规则变化时，同步改这里和种子数据。

## 兜底：演示回放

仿真环境不可用时，`npm run replay` 会按 `apps/server/src/seed/storyline.ts` 的顺序通过同一个事件桥发送演示事件，驾驶舱效果与真实仿真一致。官方数据集（默认）回放「线束03 的连锁反应」，`DATASET=demo` 时回放「一颗螺丝的涟漪」。
