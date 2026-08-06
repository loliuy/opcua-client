# Tier0 OPC UA Client 优化计划

更新时间：2026-08-06

## 目标

面向客户现场数千到数万点位，保持一个 Connection 复用少量 Subscription，每个 Subscription 承载批量 MonitoredItem；所有服务调用受服务器能力限制，断线后按期望点位集恢复，不重复订阅、不重复输出，并提供可诊断的有界队列。

OPC UA Server 节点不在本仓库范围内，继续使用独立容器。

## 当前基线

- 已完成 Browse 树、批量 Read/Write、JSON/CSV 导入、单 Subscription 多 MonitoredItem。
- 已支持 sampling/publishing interval、queue size、discard oldest、absolute/percent deadband。
- 已支持期望点位 Map、动态 replace/add/remove/clear、断线校验与重建。
- 已支持有界原生通知队列、single/batch 输出、all/latest 队列模式和丢弃诊断。
- 已完成 20,000 点真实 Node-RED 持续压测和四分片断线恢复测试。
- 已实现 Subscription 容量分片、跨分片增删恢复、50ms/500 条双阈值聚合和稳定 clientHandle 索引。
- 已实现专属 C++ `UA_Client` 所有者线程、有界命令队列、排队超时和关闭清理。
- 已完成 20,000 点采集/写入内存拆分，并将 Node-RED 内部 CSV 混合压测峰值由复测的 362.29 MB 稳定降至 226.06-226.73 MB。
- 当前缺口：安全连接、离线交付、P1/P2 扩展，以及线程模型的 ThreadSanitizer/长稳验收。

## P0：批量订阅模型闭环

### P0.1 多 Subscription 自动分片

- [x] Subscribe 节点由单个 `subscriptionId` 改为 Subscription Map。
- [x] 默认读取服务器 `MaxMonitoredItemsPerSubscription`；服务器未提供时使用节点配置的安全上限。
- [x] 每批创建默认 500 个 MonitoredItem，并使用 `MaxMonitoredItemsPerCall` 自动缩小。
- [x] 当前 Subscription 达到容量后创建下一个，删除点位后优先复用空余容量。
- [x] 每个 Subscription 独立保存 MonitoredItem 映射、通知队列和恢复状态。
- [x] replace/add/remove/clear 支持跨 Subscription 操作。
- [x] 状态输出包含 subscriptionCount、desired、monitored、failed。
- [x] 断线恢复时重建全部分片，不产生重复 MonitoredItem。

验收：配置单 Subscription 上限 1,000，导入 5,000 点，必须创建 5 个 Subscription；动态删除和追加后总点位正确；断线恢复后仍为 5 个 Subscription，最终值收敛且无重复输出。

### P0.2 通知双阈值聚合

- [x] 增加 `callbackFlushIntervalMs`，默认 50ms。
- [x] batch 模式满足“达到 500 条立即输出，或等待 50ms 后输出已有数据”。
- [x] single 模式继续逐点输出，但复用同一有界原生队列。
- [x] 多 Subscription 的通知在 Subscribe 节点统一聚合，输出保留 subscriptionId。
- [x] 保留 queue depth、capacity、lag、dropped、coalesced 诊断。

验收：低频变化在 50ms 左右输出；突发 2,000 条至少拆为 4 个不超过 500 条的批次；队列满时丢弃策略和计数准确。

### P0.3 clientHandle 和点位索引

- [x] clientHandle 在单 Subscription 内单调且唯一，不随服务批次从 1 重新开始。
- [x] 建立 `clientHandle -> 点位描述` 和 `nodeId -> Subscription/MonitoredItem` 双向索引。
- [x] 删除和重建时清理全部索引。
- [x] 通知查找保持 O(1)。

2026-08-06 阶段验证：单元测试通过；Linux/Node 20 原生编译通过；真实 Node-RED 流用 5,000 点、单 Subscription 上限 1,000 强制创建 5 个 Subscription，2 轮写入最终值 5,000/5,000 收敛、丢弃 0；服务停止并重启后恢复仍为 5 个 Subscription、5,000/5,000 点。动态增删与容量复用由单元测试覆盖。

## P0：客户端线程模型

### P0.4 单线程 UA_Client 所有权

- [x] 每个 Connection 使用一个 C++ 工作线程独占 `UA_Client`。
- [x] Connect、Browse、Read、Write、Subscription 命令进入有界命令队列。
- [x] 同一线程执行命令和 `UA_Client_run_iterate`。
- [x] Node.js Promise 仅负责入队和接收结果，不直接在多个 AsyncWorker 中访问 `UA_Client`。
- [x] 定义关闭、取消、超时和队列满行为。

验收：ThreadSanitizer/长时间压力测试无并发访问；并行触发 Read、Write、Browse、订阅增删时顺序稳定且 Node-RED 事件循环不阻塞。

2026-08-06 阶段验证：Linux/Node 20 原生编译通过；3,000 点真实服务上并发执行 12 个 Browse/Read/Write 命令，专属队列完成 13/13（含 Connect）、最大深度 4、拒绝 0，Node.js 事件循环持续响应；容量压到 1 时最大深度保持 1，7 个过载命令明确拒绝，1 个排队命令按超时安全取消。真实 Node-RED 四分片采集与断线重建均通过。ThreadSanitizer 和长时间持续并发仍待执行。

### P0.4a 大批量内存控制

- [x] 原生通知批量跨入 JavaScript，并复用变化对象，避免逐点回调和重复对象复制。
- [x] 默认仅请求 source timestamp，可按需选择 both/server/neither。
- [x] 通知不重复携带 sampling interval、queue、deadband 等静态监控配置。
- [x] Write CSV 单遍扫描，直接生成最终写入描述，避免多套 20,000 行中间对象同时驻留。
- [x] 分阶段记录 Node-RED RSS，并支持外部写入器隔离采集链路内存。

2026-08-06 阶段验证：外部写入器产生 100,000 次变化时，Node-RED 完成 Browse、Read、四分片 Subscribe 和 120,000 条通知采集，峰值 RSS 170.27 MB；Node-RED 内部 CSV Write 优化后两次全新进程混合压测峰值分别为 226.73 MB 和 226.06 MB，均为 120,000/120,000 原生通知、丢弃 0、最终值 20,000/20,000 收敛。

20,000 点故障注入验收：真实服务停止并重启后，Subscribe 节点重建 4 个 Subscription 和 20,000/20,000 个 MonitoredItem，失败 0；恢复后 60,000/60,000 条原生通知送达、丢弃 0、最终值 20,000/20,000 收敛，恢复阶段峰值 RSS 175.04 MB。

## P0：安全与交付

### P0.5 安全连接

- [ ] open62541 开启加密后端。
- [ ] 支持 None、Sign、SignAndEncrypt 和配置的 SecurityPolicy。
- [ ] certificate、privateKey、用户名和密码使用 Node-RED credentials 存储。
- [ ] 增加证书信任、拒绝列表和错误提示。
- [ ] 增加安全端点真实连接测试。

### P0.6 npm 与 Enterprise 离线交付

- [ ] 发布 `@tier0/opcua-client`。
- [ ] 离线包携带固定版本 open62541 源码或预编译产物，安装时不访问 GitHub。
- [ ] Enterprise `packages.txt` 改为离线 tgz。
- [ ] 更新 palette 隐藏逻辑，识别 `@tier0/opcua-client` 和 `tier0-opcua-*`。
- [ ] 更新 Node-RED 镜像编译依赖和安装/升级回归。
- [ ] 验证全新安装、升级安装、失败后再次运行 `bin/nodered-packages.sh`。

## P1：原版常用能力

- [ ] OPC UA RegisterNodes/UnregisterNodes 服务，并与 NodeId cache 明确区分。
- [ ] 通用 Info/Attributes 节点。
- [ ] Read/Write IndexRange。
- [ ] Write 数组和矩阵类型。
- [ ] Endpoint Discovery 和端点选择。

## P2：扩展能力

- [ ] History Read。
- [ ] Method Call。
- [ ] Events、Condition、Acknowledge。
- [ ] OPC UA File Transfer。

## 输出契约

- Read batch：`msg.payload` 为结果数组，`msg.opcua` 包含 operation、total、good 和 clientDiagnostics。
- Subscribe single：`msg.topic=nodeId`，`msg.payload=value`，`msg.opcua` 为点位和队列信息。
- Subscribe batch：`msg.payload` 为变化数组，`msg.opcua` 包含 operation、total、subscriptionCount 和合并后的队列诊断。
- Subscription status：包含 command、desired、monitored、subscriptionCount、failed、recovered、rebuilt 和 dataGapPossible。
- 错误不得静默；服务失败、队列溢出和恢复失败必须进入状态、日志或消息诊断。

## 验证矩阵

- 单元测试：分片、容量回收、去重、双阈值聚合、OperationLimits、输出契约。
- 原生集成：真实 open62541 服务、队列溢出、clientHandle 唯一性、安全连接。
- Node-RED 真实流：100、1,000、5,000、10,000 点 Browse/Read/Write/Subscribe。
- 故障注入：服务停止、短断线、Session 丢失、Subscription 失效、恢复期间动态改点。
- 交付回归：在线 npm、离线 tgz、全新安装、升级、重复安装。

## 实施顺序

1. P0.1 多 Subscription 分片。
2. P0.2 双阈值聚合。
3. P0.3 clientHandle 索引。
4. P0.4 单线程命令队列。
5. P0.5 安全连接。
6. P0.6 npm 和 Enterprise 离线交付。
7. P1 常用能力。
8. P2 扩展能力。
