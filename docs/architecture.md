# pi-pair 目标架构（根子上重构）

现状问题：三层审计（L0/L1/L2）+ 双 spawn 路径 + 三套锁 + 双注入去重 + 13 字段状态

+ 1112 行单体扩展——机制叠加导致每次需求都连锁修 bug。

目标：**单层审计 + 单一数据流 + 最小状态**，测试驱动锁定行为。

## 设计原则

1. **一个审计者，一次任务**：每轮对话一次审计任务 = 推导目标 + 审产物 + 签名。
   不做 L0 链维护 / L1 门禁 / L2 交付审查的分层。
2. **fresh spawn + 会话上下文延续**：每次审计新起 run（不常驻），但 spawn 用
   `context: "fork"`（继承主会话上下文）+ 任务注入会话上下文摘要（convlog 尾部 /
   决策链 / 上次签名 / process log 路径）——审计者理解"同一会话"在做什么，而非从零开始。
3. **真实产物才审计**：git 未提交改动 或 未审计决策条目 → 审；否则零噪音。
4. **交付轮同步门禁，常规轮异步**：交付词（提交/发布/merge/部署…）→ agent_end 等签名；
   常规轮 → spawn 后不阻塞。
5. **价值点可观察，流程隐藏**：blockers/auditFindings → display:true 注入（用户感知价值）；
   等待/计数/协商等流程信息不呈现（无 chainFindings 内部通道——单层审计直接签名）。
6. **持续交付 + 中间态**：审计者边审边写 auditFindings（被杀也有产出）；
   blocked → async-complete 立即 sendUserMessage 交付主 agent。
7. **完成即停**：签名后审计者立即停止，疑问留给下一轮。

## 状态机（精简）

### signature.status

+ `null` → 未审计
+ `passed` → 通过（blockedStreak 清零）
+ `blocked` → 有缺口（blockedStreak+1；signatureConvLine 不推进）
+ `passed-with-warning` → 交付轮超时降级 或 连续 blocked≥3（A2 退出，blockedStreak 清零）
+ `timeout` 状态**不存在**（超时直接降级 passed-with-warning）

### 转移

```
agent_end（有产物）:
  ├─ 常规轮 → spawn/resume（异步，不 await）→ inFlight=true
  ├─ 交付轮 → spawn/resume → await 签名（300s 上限）
  │     ├─ passed → 门禁通过
  │     ├─ blocked（streak<3）→ 保留 blocked，下轮注入
  │     ├─ blocked（streak≥3）→ 降级 passed-with-warning
  │     └─ 超时 → 降级 passed-with-warning + findings 下轮注入
  └─ 无产物 → 不触发（零噪音）

before_agent_start:
  ├─ signature.blocked/passed-with-warning 且未注入 → display:true 价值点注入
  └─ auditFindings 非空 且审计未完成 → display:true 中间态注入

async-complete（审计完成）:
  └─ signature.blocked → sendUserMessage 立即交付主 agent

session_start → 重置根缓存
session_shutdown → 清内存锁 + 根缓存（fresh spawn 无 run 可停，无残留）
```

## 文件结构

+ `lib/chain-store.ts`：纯存储（chain 读写/解析、convlog、process、state、真实产物判定）
+ `extensions/decision-chain.ts`：编排（RPC、任务构建、事件接线、注入）
+ `docs/audit-state-machine.md`：状态机权威文档
+ `test/chain-store.test.ts`：存储层单测 + 接线守卫

## 可删除的现状冗余

| 现状 | 处理 |
| --- | --- |
| `timeout` 签名状态 | 删除（超时=passed-with-warning 降级） |
| `negotiateStop` 600s 协商 | 已删 |
| `handleBlocked` 刷屏 | 已删（注入替代） |
| `chainFindings` 注入 display:false | 已删（单层审计直接签名，无独立链维护通道） |
| 双注入去重 map 互相覆盖 | 已拆分为独立 map（signature/interim） |
| session_start 预 spawn | 已删（fresh spawn，agent_end 按真实产物触发） |
