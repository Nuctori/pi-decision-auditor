# 审计状态机（pi-pair 结对审计）

权威状态转移定义。代码实现（`lib/chain-store.ts` + `extensions/decision-chain.ts`）必须与本文档一致；
修改任何状态转移时先改本文档，再改代码，再补测试。

## 状态（AuditState / signature）

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `inFlight` | `false \| true` | 是否有审计 run 在跑（防重入） |
| `signature.status` | `null \| "passed" \| "blocked" \| "passed-with-warning"` | 最近一次审计结论 |
| `signature.blockers` | `string[]` | blocked / passed-with-warning 时的具体缺口（价值点） |
| `signature.at` | `epoch ms` | 签名时间（注入去重键） |
| `blockedStreak` | `0..3` | 连续 blocked 次数（A2 门禁） |
| `signatureConvLine` | `number` | 签名覆盖到的 convlog 行号（防签名过期复用） |
| `auditFindings` | `string[]` | 审计中间态（审计者边审边追加，被杀/超时也可交付） |

> **已移除状态/字段**：`timeout`（v1.0.15 前存在）——超时直接降级为
> `passed-with-warning` + blockers（无 600s 协商黑洞）。`chainFindings` / `auditorRunId` /
> `roundsSinceAudit` / `pendingChars`（v1.0.15 架构重构删除——单层审计 + fresh spawn）。

## 状态转移

### T1. agent_end 触发（每轮结束时）

```
[本轮无真实产物] ── hasUncommittedChanges=false 且 entriesSinceLastAudit 为空 ──▶ 不触发（零噪音）
[多实例混写]     ── convlogForeignRuns>0 ──────────────────────────────────▶ 跳过 + notify（防错审）
[常规轮]         ── fresh spawn（context:"fork"）→ inFlight=true → 立即返回（不阻塞）
[交付轮]         ── fresh spawn → inFlight=true → await 签名（300s 上限）
```

### T2. 审计者收尾（写入 signature）

```
审计通过        → signature={status:"passed"}、signatureConvLine=当前行、blockedStreak=0
发现缺口        → signature={status:"blocked", blockers:[...]}、signatureConvLine 不推进、blockedStreak+1
交付轮超时      → signature={status:"passed-with-warning", blockers:[超时提示]}、blockedStreak=0
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
auditFindings 非空 且 (inFlight 残留 或 无签名) 且未注入过（injectedInterimAt≠auditStartedAt）
  → 中间态注入 display:true（审计被杀/超时的部分发现）
```

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

1. **签名必覆盖**：`signature` 存在 ⇔ `signatureConvLine ≥ 当前行`（passed 时），blocked 时不推进（待修复）。
2. **单写者**：state.json 原子写（tmp+rename）；inFlight 防并发双审计；多实例混写检测跳过；
   签名即释放 inFlight（recordSignature 置 false）；agent_end 对"文件锁残留但内存锁无"兜底释放。
3. **价值点可观察 / 流程隐藏**：审计抓出的缺口（blockers / auditFindings）display:true；
   等待/计数/协商等流程信息不呈现给用户。
4. **生命周期 = fresh spawn**：每次审计新起 run（context:"fork" 继承主会话上下文），审计完即死；
   session_shutdown 只清内存锁——无跨会话残留，纯咨询会话零后台 run。
5. **中间态优先**：审计者宁可多写 auditFindings（每步核实即追加），不可最后一起写（被杀即丢）。
6. **blocked 也是完成**：本轮新签名（signature.at ≥ auditStartedAt 且 !inFlight）即完成判定——
   blocked 签名不推进 signatureConvLine 但仍是本轮结论，交付轮不得误判为超时（防覆盖真实 blockers）。

## 测试锁定

- `blockedStreak`：blocked 递增、passed / passed-with-warning 清零（test/chain-store.test.ts）
- `needsSignoff` 状态机：无对话→false；有对话→true；签名后→false；blocked 也解除待签名
- `recordSignature` 释放 inFlight（签名=审计结束，防锁泄漏）
- 接线守卫：真实产物判定、交付标记先消费（无泄漏）、fresh spawn（无 L0/常驻 run）、
  价值点 display:true、L2 真实产物门禁、async-complete 持续交付、完成即停
