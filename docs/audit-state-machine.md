# 审计状态机（pi-pair 结对审计）

权威状态转移定义。代码实现（`lib/chain-store.ts` + `extensions/decision-chain.ts`）必须与本文档一致；
修改任何状态转移时先改本文档，再改代码，再补测试。

## 状态（AuditState / signature）

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `inFlight` | `false \| true` | 是否有审计 run 在跑（防重入） |
| `signature.status` | `null \| "passed" \| "blocked" \| "passed-with-warning"` | 最近一次审计结论 |
| `signature.blockers` | `string[]` | blocked / passed-with-warning 时的具体缺口（价值点） |
| `signature.at` | `epoch ms` | 签名时间（注入去重键 + 完成判定键） |
| `blockedStreak` | `0..3` | 连续 blocked 次数（A2 门禁） |
| `signatureConvLine` | `number` | 签名覆盖到的 convlog 对话行数（每次签名都推进到当前行，needsSignoff 用） |
| `auditFindings` | `string[]` | 审计中间态（审计者边审边追加，被杀/超时也可交付）；纯咨询占位（`"本轮纯咨询，无审计对象"`）不算真实中间态 |
| `gatedHead` | `null \| 短哈希` | 交付门禁基线（上次门禁覆盖的 HEAD；v1.0.23 持久化——扩展热重载后惰性初始化从 state 恢复，不把热重载后刚提交的修复吞成基线） |

> **已移除状态/字段**：`timeout`（v1.0.15 前存在）——超时直接降级为
> `passed-with-warning` + blockers（无 600s 协商黑洞）。`chainFindings` / `auditorRunId` /
> `roundsSinceAudit` / `pendingChars`（v1.0.15 架构重构删除——单层审计 + fresh spawn）。

## 状态转移

### T1. agent_end 触发（每轮结束时）

```
[无代码产物 且 无对话增量] ── hasUncommittedChanges=false 且 hasNewConversation=false ──▶ 不触发（零噪音）
[纯咨询轮]        ── 对话增量但无 decision_add 决策信号、无 git 产物/提交 ──▶ 不 spawn（零噪音承诺升级：零注入 → 零 spawn，用户实测每轮问答 spawn 审计者 + 后台完成通知 = 污染）
[plan 轮（无产物）] ── 未调 decision_add → 不 spawn，convExtractedLine 停留 → 决策由下一个产物轮的审计者按增量窗口顺带提取（不丢，仅延迟）；纯 plan 会话用 /pair-audit 或 decision_add 兜底
[多实例混写]     ── convlogForeignRuns>0（并发窗口：本实例首行之后的外来行）──▶ 跳过 + notify（防错审）
[常规轮]         ── fresh spawn（context:"fork"）→ inFlight=true → 立即返回（不阻塞）
[交付轮]         ── git HEAD 变化（本轮产生了提交 = 交付的客观信号；无词表/模式匹配——完工语义判断不可靠，v1.0.17 先例）→ fresh spawn → inFlight=true → await 签名（300s 上限）

触发后审计者【第零步】AI 判定本轮有无工作（不做正则信号词判定——语义判断交给审计者）：
  纯咨询（问答无决策无产物）→ 快速退出：推进 convExtractedLine（对话行计数，非文件行号）、写 auditFindings=["本轮纯咨询，无审计对象"]、不写 signature、零注入
  plan 阶段（有决策无 git 产物）→ 提取决策入链 + 审决策质量 + 签名
  实现阶段（有 git 产物）→ 审产物 + 签名
```

### T2. 审计者收尾（写入 signature）

```
审计通过        → signature={status:"passed", at:now}、signatureConvLine=当前对话行、blockedStreak=0
发现缺口        → signature={status:"blocked", blockers:[...], at:now}、signatureConvLine 同样推进（签名即推进——修复走 blockers 注入通道，不靠 convLine 滞后）、blockedStreak+1
交付轮超时      → signature={status:"passed-with-warning", blockers=已确认的 auditFindings（价值点，无 findings 才给超时提示）}、blockedStreak=0
连续 blocked≥3  → signature={status:"passed-with-warning", blockers: 原缺口}、blockedStreak=0（A2 降级放行）
```

### T3. 持续交付（价值点，用户可观察）

```
审计者完成（async-complete）且 signature.blocked
  → sendUserMessage 立即交付主 agent（"结对审计发现 N 个缺口…"）
  → 主 agent 处理 → 下轮 agent_end 自动再审 → 直到干净
```

### T4. findings 注入（before_agent_start，每条独立 display）

```
signature.blocked / passed-with-warning 且未注入过（injectedSignatureAt≠signature.at）
  → 价值点注入 display:true（用户可观察：审计抓出的缺口）
auditFindings 非空（过滤纯咨询占位后）且（inFlight===true 或 signature===null）且未注入过（injectedInterimAt≠auditStartedAt）
  → 中间态注入 display:true（审计被杀/超时的部分发现；纯咨询轮占位过滤后不注入——零注入承诺；
    signature===null 分支覆盖会话早结被杀后新会话 reset 清 inFlight 的跨会话交付）

### T5. 生命周期（fresh spawn，无常驻 run）

```

agent_end（有真实产物）→ fresh spawn 审计者（context:"fork" 继承主会话上下文）
审计完成            → run 自然结束（无跨轮复用、无生命周期登记）
session_shutdown    → 清内存锁（inFlightAudits）+ 根缓存——无残留 run 可停

```

### T6. recordSignature 副作用（lib/chain-store.ts）

```

blocked          → blockedStreak+1（A2 计数）
passed           → blockedStreak=0
passed-with-warning → blockedStreak=0（降级放行即退出门禁循环）
每次签名         → inFlight=false（释放锁，防 decision_signoff 路径泄漏）+ signatureConvLine = 当前行

```

## 不变量

1. **签名必覆盖**：`signature` 存在 ⇔ `signatureConvLine = 签名时的对话行总数`（passed / blocked 都推进——修复经 blockers 注入通道，不靠 convLine 滞后）。
2. **单写者**：state.json 原子写（tmp+rename）+ **mtime 乐观锁**（writeAuditState 带 expectedMtime——读后写前校验，他写者已改 → 放弃提交防丢失更新；recordSignature 冲突重试一次；其余写点冲突放弃并 warn）；inFlight 防并发双审计；多实例混写检测跳过；
   签名即释放 inFlight（recordSignature 置 false）；agent_end 对"文件锁残留但内存锁无"兜底释放。
3. **价值点可观察 / 流程隐藏**：审计抓出的缺口（blockers / auditFindings）display:true；
   等待/计数/协商等流程信息不呈现给用户；纯咨询轮零注入（inFlight=false 不触发中间态注入）。
4. **生命周期 = fresh spawn**：每次审计新起 run（context:"fork" 继承主会话上下文），审计完即死；
   session_shutdown 只清内存锁——无跨会话残留，纯咨询轮 spawn 后快速退出（零后台停留）。
5. **中间态优先**：审计者宁可多写 auditFindings（每步核实即追加），不可最后一起写（被杀即丢）。
6. **blocked 也是完成**：本轮新签名（signature.at ≥ auditStartedAt 且 !inFlight）即完成判定——
   blocked 仍推进 signatureConvLine，完成判定只看 at，交付轮不得误判为超时（防覆盖真实 blockers）。
7. **游标单位一致**：convExtractedLine / signatureConvLine 一律为对话行计数（## 👤/## 🤖 行数）；
   扩展在 agent_end 用 clampConvExtractedLine 钳制（审计者写文件行号超界 → 视为已读完，防触发断线）。

## 测试锁定

- `blockedStreak`：blocked 递增、passed / passed-with-warning 清零（test/chain-store.test.ts）
- `needsSignoff` 状态机：无对话→false；有对话→true；签名后→false；blocked 也解除待签名
- `recordSignature` 释放 inFlight（签名=审计结束，防锁泄漏）
- `clampConvExtractedLine` 单位钳制：审计者写文件行号超界 → 钳制为对话行总数（防触发断线）
- 接线守卫：真实产物判定、交付标记先消费（无泄漏）、fresh spawn（无 L0/常驻 run）、
  价值点 display:true、L2 真实产物门禁、async-complete 持续交付、完成即停、中间态注入判据（inFlight===true）

## 审计者子进程 state 字段责任表（2026-08-13 并发覆盖事故后）

state.json 是共享文件（extension 与审计者子进程并发读写）。M3 修复分两层：extension 侧 writeAuditState mtime 乐观锁（冲突放弃）；审计者子进程侧【state 写入纪律】（字段级合并写——write 前 read 最新、只改自己字段、其他原样保留、write 后 read 验证）。

| 字段 | 审计者子进程（write 工具）| extension（writeAuditState）|
|---|---|---|
| auditFindings | ✅ 负责（中间态追加/占位替换）| 只读（注入/降级读取）|
| inFlight | ✅ 负责（中间态保持 true，收尾 false）| ✅ 锁管理（spawn 前置位/清残留）|
| convExtractedLine | ✅ 负责（推进）| 钳制（读）|
| signature / signatureConvLine / lastAuditedId / lastAuditAt | ✅ 负责（收尾写）| 只读 + 降级写（超时 passed-with-warning）|
| 其他字段 | 禁止覆盖 | 只读 |

冲突检测：审计者 write 前 read，若目标字段已被推进（值 > read 时）→ 基于最新值，绝不回退覆盖。
