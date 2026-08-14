# 审计状态机（pi-pair 结对审计）

权威状态转移定义。代码实现（`lib/chain-store.ts` + `extensions/decision-chain.ts`）必须与本文档一致；
修改任何状态转移时先改本文档，再改代码，再补测试。

## 状态（AuditState / signature）

| 字段 | 取值 | 含义 |
| --- | --- | --- |
| `inFlight` | `false \| true` | 是否有审计 run 在跑（防重入） |
| `signature.status` | `null \| "passed" \| "blocked" \| "passed-with-warning" \| "failed"` | 最近一次审计结论（failed = 审计未触发/spawn 失败，非产物问题） |
| `signature.blockers` | `string[]` | blocked / passed-with-warning 时的具体缺口（价值点） |
| `signature.reason` | `string` | failed 时的扩展记账原因（v1.0.26 L4：扩展属主字段，审计者不写） |
| `signature.at` | `epoch ms` | 签名时间（注入去重键 + 完成判定键） |
| `blockedStreak` | `0..3` | 连续 blocked 次数（A2 门禁） |
| `signatureConvLine` | `number` | 签名覆盖到的 convlog 对话行数（每次签名都推进到当前行，needsSignoff 用） |
| `auditFindings` | `string[]` | 审计中间态（审计者边审边追加，被杀/超时也可交付）；纯咨询占位（`"本轮纯咨询，无审计对象"`）不算真实中间态 |
| `auditRunId` | `string` | 本轮 spawn 的审计者 runId（扩展 spawn 成功后写；完成判定与签名 runId 比对——防遗留/并发审计者劫持门禁，v1.0.26 JD #14） |
| `lastError` | `null \| string` | 最近一次扩展逻辑异常摘要（agent_end catch 落盘，防静默吞错不可观测，v1.0.26 JD #17） |
| `gatedHead` | `null \| 全哈希` | 交付门禁基线（上次门禁覆盖的 HEAD，gitHead() 全哈希；v1.0.23 持久化——扩展热重载后惰性初始化从 state 恢复，不把热重载后刚提交的修复吞成基线） |

> **已移除状态/字段**：`timeout`（v1.0.15 前存在）——超时直接降级为
> `passed-with-warning` + blockers（无 600s 协商黑洞）。`chainFindings` / `auditorRunId` /
> `roundsSinceAudit` / `pendingChars`（v1.0.15 架构重构删除——单层审计 + fresh spawn）。

### failed 状态（2026-08-14 新增）

**触发**：spawn 审计者失败（rpc spawn 抛错/超时）——审计**未触发**。

**语义**：不是产物质量问题（产物没被审，不等于产物有问题）。因此：

- 不递增 `blockedStreak`（A2 门禁不计数）；
- 不推进 `signatureConvLine`（审计未覆盖产物，下轮 `hasWork`/`needsSignoff` 仍判定有增量 → 自动重新 spawn）；
- 不注入 blockers（不走修复轮，不产生“审计触发失败，产物未过审”假缺口）；
- `signature.reason` 记录真实原因（如“审计触发失败：spawn 失败，下轮重试”）；**不再写 `auditFindings`**（v1.0.26 L4：扩展记账文本与审计者发现字段分离，防超时降级把它当价值点注入）；
- 完成判定（`signature.at ≥ auditStartedAt`）与降级跳过逻辑对 failed **不适用**——failed 不会到达门禁等待路径（spawn 失败即 return）。

**恢复**：下轮 agent_end `hasWork` 为真（产物仍在）时自动重新 spawn——无需人工干预。

**呼吸灯**：spawn 失败 / 残留锁清理 / async-complete TTL 过期均灭灯（防“审计进行中”永久常亮——实证：审计者 run 卡死无产出时 UI 提示持续 7220s）。

## 状态转移

### T1. agent_end 触发（每轮结束时）

```
[无代码产物 且 无对话增量] ── hasUncommittedChanges=false 且 hasNewConversation=false ──▶ 不触发（零噪音）
[纯咨询轮]        ── 对话增量但无 decision_add 决策信号、无 git 产物/提交 ──▶ 不 spawn（零噪音承诺升级：零注入 → 零 spawn，用户实测每轮问答 spawn 审计者 + 后台完成通知 = 污染）
[plan 轮（无产物）] ── 未调 decision_add → 不 spawn，convExtractedLine 停留 → 决策由下一个产物轮的审计者按增量窗口顺带提取（不丢，仅延迟）；纯 plan 会话用 /pair-audit 或 decision_add 兜底
[多实例混写]     ── convlogForeignRuns>0（并发窗口：本实例首行之后的外来行）──▶ 跳过 + notify（防错审）
[常规轮]         ── fresh spawn（context:"fork"）→ inFlight=true → 立即返回（不阻塞）
[交付轮]         ── git HEAD 变化（本轮产生了提交 = 交付的客观信号；无词表/模式匹配——完工语义判断不可靠，v1.0.17 先例）→ fresh spawn → inFlight=true → 后台轮询签名（2s 间隔，300s 上限；用户发新消息可解除等待，结论仍交付）

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
  → sendUserMessage 立即交付主 agent（"结对审计发现 N 个缺口…"）——**先交付后持久化去重**
    （v1.0.29 F6：交付失败不落盘，注入路径接管，防 blockers 永久不可见）
  → 主 agent 处理 → 下轮 agent_end 自动再审 → 直到干净
```

### T4. findings 注入（before_agent_start）

```
signature.blocked / passed-with-warning 且未注入过（injectedSignatureAt≠signature.at）
  → 同会话（auditStartedAt ≥ sessionStartAtWall = 本会话 spawn 的审计）→ display:true 注入
  → 跨会话（auditStartedAt < sessionStartAtWall = 上会话遗留结论）
    → **写项目文件 .pi/decision-auditor/latest-audit.md + 轻 notify，不注入对话**（v1.0.29 D-036：
      跨会话交付到项目，不是会话——防上会话审计串扰无关新任务，用户实证 run-31044）
auditFindings 非空（过滤纯咨询占位后）且（inFlight===true 或 signature===null）且未注入过（injectedInterimAt≠auditStartedAt）
  → 同规则分流：同会话注入 display:true / 跨会话写项目文件
  （中间态 = 审计被杀/超时的部分发现；纯咨询轮占位过滤后不注入——零注入承诺）
去重标记内存 set 在 patch 成功之后（v1.0.29 F8：patch 失败同会话下轮可重试，不压制价值）

### T5. 生命周期（fresh spawn + 孤儿 run 回收）

```

agent_end（有真实产物）→ fresh spawn 审计者（context:"fork" 继承主会话上下文）
审计完成            → run 自然结束（无跨轮复用、无生命周期登记）
session_shutdown    → 只处理本实例 root 的 in-flight 条目（v1.0.29 F10：不清其他 cwd 实例）；
                      超 TTL run best-effort stop（成功才清文件锁，F-02 身份守卫）；
                      未 stop 的 run 登记孤儿表（scheduleOrphanStop，v1.0.29 F4/B-2）——
                      TTL 剩余时间到点单发 stop（runId 不随条目清空丢失，挂起 run 不再无界泄漏）
agent_end catch     → 删条目前先 stopRun（v1.0.29 B-1：孤儿 run runId 不丢失）
L2 reviewer         → 登记时挂 TTL 定时器（v1.0.29 F9：挂起 reviewer 会话内回收）

```

### T6. recordSignature 副作用（lib/chain-store.ts）

```

blocked          → blockedStreak+1（A2 计数）
passed           → blockedStreak=0
passed-with-warning → blockedStreak=0（降级放行即退出门禁循环）
每次签名         → inFlight=false（释放锁，防 decision_signoff 路径泄漏）+ signatureConvLine = 当前行
幂等（v1.0.26 JD #20）：已有签名且 status/blockers 相同且 at ≥ auditStartedAt → no-op
  （重复 signoff 不重写 at——去重键失效 → blockers 重复注入；不增 streak——A2 早触发降级）

```

## 并发与异常防护（v1.0.26 双审计修复汇总）

- **写路径**：state.json 原子写 tmp 名按写者唯一（`${file}.tmp-<pid>-<随机>`——共享固定
  `.tmp` 名双写者交错会互相覆盖/ENOENT/半成品落盘，JD #14 双审计 critical#1）；rename 失败
  按冲突返回 false；**写后验证**（rename 后重读磁盘内容 ≠ 本次写入 → 冲突，JD #16）——
  单次重试不覆盖检查-写入窗口内到达的写入。
- **chain.md append**：appendDecision 加 mtime 乐观锁 + 冲突重试（最多 3 次），防并发写者
  重复 D-NNN（JD #14 双审计 high#2）。
- **残留锁清理**：shouldClearStaleLock / resetForSessionStart 均加 auditStartedAt 年龄条件
  （仅当审计启动已超 TTL 才清锁）——热重载后内存锁清空但审计者仍在跑时不得并发双审计
  （JD #15 + FP #6）；resetForSessionStart 保留 inFlight 让遗留审计者先收尾。
- **超时降级**：waitForAuditCompletion 返回 null 后先重读 state 用 isAuditCompleted 再查一次
  （≤2s 盲窗内审计者真实签名不得被 passed-with-warning 覆盖，JD #19），并 rpc stop 终止
  仍挂着的审计者 run（FP #13，资源泄露 + 迟到写竞争；stop 失败不影响降级放行）。
- **异常可观测**：agent_end 外层 catch console.error + lastError 落盘（JD #17，防整轮无痕）。
- **公共链自触发**：PI_PAIR_CHAIN_PUBLIC=1 时 hasUncommittedChanges pathspec 排除
  docs/decisions（链自身写入不触发审计循环，JD #18）。
- **会话级状态**：roundDecisionMade append 成功后置位 + session_start 清零（print 模式
  agent_end 不执行时防残留误触发，FP #3）；内存锁 TTL 用 performance.now() 单调钟
  （墙钟跳变不早/晚过期，FP low）。
- **v1.0.28 双审计批次（F-01~F-10 / LC-03~LC-10）**：
  - F-01 锁劫持根治：patchAuditState 函数式重派生（latest）=> 值 | null，锁获取点持锁放弃；
  - F-02 session_shutdown 清锁身份守卫（auditRunId 匹配才清，不杀他会话新锁）；
  - F-03/LC-05 孤儿 run 闭环：spawn 超时保留锁由 TTL 兜底 + runId 已知先 stopRun + failed 写检查返回值；
  - LC-03 门禁归属校验：交付轮等待前验证在跑审计是本会话 spawn（auditStartedAtWall 匹配 +
    内存条目存在；ownAudit 缺失同样拦截——跨进程/切会话残留锁不劫持门禁）；
  - LC-06 完成判定时钟容差 5min（跨主机/网络盘偏移不假超时，runId 身份校验独立把关）；
  - LC-07 appendDecision mtime 先于 read + rename 紧前复校验 + 写后验证末尾条目；
  - F-05 中间态注入滤'审计开始'占位（在跑审计 ≠ 被中断）；F-06 注入去重持久化前移
    （patch 成功才注入）；F-07 convlogForeignRuns 50 行时间窗（防会话内永久停摆）；
  - F-08 L2 冷却键 (cwd,head) + unref；F-09 convLineCache 键加尾哈希；
  - LC-08 warn 带 pid + 损坏读告警 + lastError 成功路径清理；LC-09 .corrupt 备份扫描恢复。
- **v1.0.29 生命周期关系修复（D-036 + 双审计 F3~F12/B-1/B-2）**：
  - D-036 跨会话交付改走项目文件：before_agent_start 判 auditStartedAt < sessionStartAtWall
    = 上会话遗留结论 → 写 .pi/decision-auditor/latest-audit.md + 轻 notify，不注入对话
    （用户实证：上会话审计中间态注入无关新会话干扰新任务）；
  - F3 门禁完成/recheck/超时三分支一致删内存条目（防条目残留期间新提交被旧签名放行）；
  - F4/B-2 孤儿 run 登记表 + TTL 到点单发 stop（session_shutdown 未 stop 的 run 不再永久泄漏）；
  - B-1 agent_end catch 删条目前先 stopRun；F9 L2 reviewer 登记时挂 TTL 定时器；
  - F6 async-complete 先交付后持久化去重（交付失败不落盘，注入路径接管）；
  - F8 注入去重内存 set 移到 patch 成功之后（patch 失败同会话下轮可重试）；
  - F5 failed 重试轮（无本轮未提交产物）同步短路（不升级 300s 门禁阻塞主会话；
    判据不含 !hasNewCommit——有未覆盖提交时 hasNewCommit 恰为 true，复审风险 1 修复）；
  - F7 agent_end stale-lock 清理 await stopRun 按结果清文件锁（与 F-02 同策略）；
  - F10 session_shutdown 只处理本实例 root 条目（不 stop/不清其他 cwd 实例的条目——
    全清会让对方 runId 丢失无终止路径，复审风险 2 修复）；
  - F12 /pair-audit 锁 patch 同步清空 auditFindings（与 agent_end JD#23 对齐）。

## 不变量

1. **签名必覆盖**：`signature` 存在 ⇔ `signatureConvLine = 签名时的对话行总数`（passed / blocked 都推进——修复经 blockers 注入通道，不靠 convLine 滞后）。
2. **单写者**：state.json 原子写（tmp+rename）+ **mtime 乐观锁**（writeAuditState 带 expectedMtime——读后写前校验，他写者已改 → 放弃提交防丢失更新；recordSignature 冲突重试一次；其余写点冲突放弃并 warn）；inFlight 防并发双审计；多实例混写检测跳过；
   签名即释放 inFlight（recordSignature 置 false）；agent_end 对"文件锁残留但内存锁无"兜底释放。
3. **价值点可观察 / 流程隐藏**：审计抓出的缺口（blockers / auditFindings）display:true；
   等待/计数/协商等流程信息不呈现给用户；纯咨询轮零注入（inFlight=false 不触发中间态注入）。
4. **生命周期 = fresh spawn + 孤儿回收**：每次审计新起 run（context:"fork" 继承主会话上下文），
   审计完即死；session_shutdown 只处理本实例条目 + 未 stop 的 run 登记孤儿表（TTL 到点 stop）；
   纯咨询轮 spawn 后快速退出（零后台停留）。挂起 run 恒有终止路径（agent_end deadAuditor /
   async-complete TTL 循环 / shutdown 孤儿表 / L2 reviewer 定时器）。
5. **中间态优先**：审计者宁可多写 auditFindings（每步核实即追加），不可最后一起写（被杀即丢）。
6. **blocked 也是完成**：本轮新签名（signature.at ≥ auditStartedAt - 5min 容差 且 !inFlight）即完成判定——
   blocked 仍推进 signatureConvLine，完成判定只看 at（LC-06：5min 时钟容差吸收跨主机偏移），
   交付轮不得误判为超时（防覆盖真实 blockers）。
   完成判定抽为 `isAuditCompleted` 纯函数（v1.0.26）：failed 永不视为完成（spawn 失败标记，
   非审计签名）；`state.auditRunId` 与签名 `runId` 同时存在时必须匹配——遗留/并发审计者的
   签名不得劫持本会话门禁结论（JD #14）。
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
