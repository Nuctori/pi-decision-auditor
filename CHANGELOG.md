# Changelog

## [1.0.28] - 2026-08-14

生命周期审计第三轮（函数式专家 F-01~10 + Jeff Dean 系统设计 LC-01~10 双视角独立审查，独立 reviewer 复审闭环）——并发读写、多会话共享私人数据空间（.pi/decision-auditor/）、跨会话串台：

- **F-01 锁劫持根治（high）**：patchAuditState 重试曾把调用方一次性构建的陈旧 patch 值覆盖并发写者（锁获取 patch {inFlight:true, auditStartedAt} 在 attempt 1 用旧 auditStartedAt 覆盖他方已推进值 → 双实例都认为持锁各自 spawn 双审计）。patch 支持函数式重派生 `(latest) => Partial | null`：重试轮从 fresh state 重派生，最新已持锁返回 null 放弃；agent_end 与 /pair-audit 两个锁获取点改函数式（值固定到 lockStartedAtWall 变量，成功落盘后记入内存条目）
- **F-02 会话身份守卫（high）**：session_shutdown 的 inFlight:false 补丁此前无条件清锁——await stopRun（≤10s）窗口内他会话重获新锁会被清掉 → 对方审计无锁运行 + 下轮双审计。补丁加身份守卫：仅当磁盘锁仍属于被 stop 的 run（auditRunId 匹配，或 runId 为空时）才清
- **F-03/LC-05 孤儿 run 闭环（high）**：spawn rpc 900s 客户端超时 ≠ run 终止——catch 立即释放锁 + failed 标记 → 下轮重 spawn 与孤儿 run 并发双审计。改：runId 已知先 stopRun 再释放；runId 未知（rpc 超时，run 可能存活）**保留锁与内存条目**，由 TTL + stale-lock 兜底释放（并发双写转为有界停摆 ≤16min）；failed 写检查返回值——写冲突失败保留内存锁（防 failed 标记丢失 + 锁已释放双缺口）；/pair-audit catch 同策略
- **LC-03 门禁归属校验（high，串台门禁层根治）**：state.inFlight 可能属于另一会话/另一实例，其审计者签名（runId 匹配 auditRunId 单槽）会满足 isAuditCompleted → **B 会话的门禁用 A 会话的审计结论放行**（B 的提交未审即过 + A 的 blockers 注入 B）。agent_end 门禁等待前校验：state.auditStartedAt === 本会话 spawn 时写入值（内存 auditStartedAtWall）才等待；不匹配或内存无条目（跨进程/切会话）→ 不等待不签名，通知后返回（不推进 gatedHead，锁释放后下轮重审）
- **LC-06 时钟容差（中）**：state 内容时间戳由各实例 Date.now 写入，网络盘双机共享时跨主机时钟偏移破坏 at 序（慢钟机签名 at < 快钟机 auditStartedAt → 门禁永不完成 300s 假超时）。isAuditCompleted 加 CLOCK_SKEW_GRACE_MS=5min 容差（runId 身份校验仍独立把关）；测试锁定容差内完成/超容差旧签名未完成
- **LC-07 决策链并发丢条目（high）**：appendDecision 的 expectedMtime 在 readRaw 之后捕获（read→stat 窗口吸收他写者写入）+ verify 无末尾语义（两写者交错 rename 后双方都成功返回、他写者条目被吞）。mtime 先于 readRaw 取；写后验证增加「我的 id 存在且是文件末尾条目」语义校验
- **F-05 中间态注入串台（中）**：shouldInjectInterimFindings 此前只滤纯咨询占位——审计者首写 auditFindings=['审计开始'] 即 inFlight=true，新会话首轮把「在跑审计」误当「被中断审计」注入噪音（超时降级路径 v1.0.27 已前缀过滤，注入路径漏同一过滤）。启动占位 '审计开始…' 前缀过滤（混合真实 findings 仍注入）
- **F-06 注入去重前移（中，串台残留窗口）**：注入后 patch 去重标记失败（审计者并发写 mtime 冲突恰是高频场景）→ 去重只在内存 map，新会话从 state 恢复旧值 → 同签名每个新会话重复注入（「新会话还有泄露」残留窗口）。改：**先**持久化去重标记成功才注入/才 followUp；复审补：回退值用 state 持久化值（防仅中间态注入时把已持久化签名去重标记覆写 null）
- **F-07 多实例守卫时间窗（中）**：convlogForeignRuns 守卫命中一次即会话内永久停摆（外来行永久留在 append-only 文件，无恢复路径，双实例互锁禁用自动审计）。只统计本实例首行之后最近 50 条对话行内的外来行——对方停止后守卫自然恢复，无需重启
- **F-08 L2 冷却键（低）**：deliveryAuditInFlight 30min 冷却以 cwd 为键 → 同进程新会话在冷却期内的新提交被吞 L2（修复轮最需要深度审查的时刻）。冷却键改 (cwd, head)——同 HEAD 防重复，HEAD 推进 = 新交付允许重新 fanout；setTimeout unref()
- **F-09 convLineCache 键（低）**：(mtime,size) 键在粗粒度文件系统（FAT 2s）同 tick 追加且 size 不变时返回陈旧行数 → hasNewConversation 漏判。缓存键加文件尾 64B FNV-1a 弱哈希（命中即重扫，append 场景 size 单调增成本可忽略）
- **LC-08 可观测性（低）**：冲突 warn 带写者 pid（双写者排查可归因）；readAuditState catch 区分 ENOENT（首次静默）与损坏（warn 告警，此前损坏窗口内零告警读到默认值）；agent_end 成功进入审计流程清 lastError（此前只写不清，历史异常永久显示误导诊断）
- **LC-09 损坏重建丢进度（低-中）**：.corrupt 重建此前用调用方快照（损坏时 readAuditState 返回 DEFAULT）→ 进度字段（lastAuditedId/convExtractedLine/signature/gatedHead/injected*）整体归零 → 全量重审 + 门禁基线吞未审提交 + 去重丢失重复注入。改：按 mtime 新→旧扫描全部 .corrupt-* 取第一个可解析的恢复（merge 顺序防 DEFAULT 覆盖备份进度）；「清零类补丁」（inFlight/auditFindings/lastError）总是覆盖备份（failed 释放锁/JD#23 重置生效）；rebuiltFromCorrupt 跳过 rename 前 mtime 复校验（文件已被本人 rename 走，误判冲突会让恢复在重试轮失效）
- **LC-10 projectRoot 惰性复核（低）**：首次解析后终身缓存（仅 session_start 重置）——会话内 cwd 切换时 B 目录对话写入 A 根 convlog（A 的 git 状态审 B 的对话 → 跨项目串台）。每次调用与 resolveProjectRoot 复核，变化即更新缓存（纯函数一次祖先链探测，成本可忽略）
- **F-10 呼吸灯自愈（低）**：setStatus 抛错（会话异常结束/teardown 中断，timer 无 session_shutdown 清理）→ 自清 timer 灭灯，防「审计进行中」永久常亮
- 测试：56/56 通过（+4：F-01 函数式重派生 3 断言 / LC-09 备份恢复 + 清零补丁 / F-07 时间窗 / F-05 占位前缀 / LC-06 时钟容差），tsc 0 错误

## [1.0.27] - 2026-08-14

生命周期泄露审计（v1.0.26 泄露修复的残留资源闭环）——子代理 run / 文件 / 内存状态三类资源：

- **T1 审计者 run 终止闭环（高）**：常规轮异步审计者挂起时，TTL 清理只删内存锁从不 stop run → 算力泄漏 + 迟到写 state 双写竞争。统一 best-effort `stopRun`：① agent_end stale-lock 分支（TTL 过期判定 run 已死 → stop 再清内存锁，先于 hasInFlight 取记录防 runId 丢失）；② async-complete 兜底循环（TTL 过期条目 stop）；③ session_shutdown 遍历全部 in-flight run stop——stop 成功才清文件锁（run 已死不会再写，防新会话 16min 停摆；stop 失败 = run 可能还在收尾 → 保留锁，JD#15 TTL 条件兜底）
- **T2 convlog 无界增长（中）**：convlog 永久追加无滚动截断（实测 428KB/天 ≈ 156MB/年）。超 1MB 重写为头注释 + 最近 1000 条对话行（与 process.md 同模式）；历史 convExtractedLine 超界由 clampConvExtractedLine 钳制不断线；convLineCache 按 (mtime,size) 自动失效；截断只删已提取历史，无审计窗口丢失
- **T3 state 目录垃圾文件累积（低-中）**：`.corrupt-*` 损坏备份永不清理（每次损坏 +1）；崩溃窗口 `.tmp-*` 残留无人清扫。writeAuditState 写前清扫：corrupt 只保留最新 1 份、>24h 的 tmp 残留删除（原子写目录通用 `sweepAtomicWrites`）
- **T4 agent_end 异常路径内存残留（低）**：外层 catch 只落盘 lastError → inFlightAudits 残留 16min 停摆不可观测 + 呼吸灯常亮。补删内存锁 + 灭灯（文件锁不盲清——审计者可能实际在跑，留给 stale-lock TTL 年龄条件兜底）
- **T5 会话级 Map 无界增长（低）**：gatedHead / injectedSignatureAt / injectedInterimAt / nonGitRootWarned 按 root 只增不减，常驻进程长期切项目累积。session_start 清非当前 root 条目（注入去重有 state.json 持久化兜底、gatedHead 有 agent_end 惰性恢复兜底，清内存安全）
- **独立 reviewer 验证闭环修复（fresh-context 4 路交叉复核）**：
  - M1 trimConvlog 游标保底：截断保留量从「固定 1000 行」改为「游标未覆盖行永不删除 + 已覆盖历史按 512KB 字节预算倒推」——游标滞后（纯聊天不 spawn / 审计者挂起）场景未提取行不再被物理删除（D-023 延迟而非丢失承诺在滚动截断下成立）
  - M2 CJK 行宽震荡修复：maxLen=800 字符 ≈ 2.4KB/行（实证：截断后 2.04MB > 1MB 阈值，每次 append 全量重写）→ 字节预算倒推保留行，截断后 ≤512KB 收敛，CJK 回归测试锁定
  - L3 trim 原子化：writeFileSync 直接覆盖是截断写（SIGKILL 窗口可截断整个 convlog）→ 唯一 tmp + rename；mtime 写前校验（多实例共享文件 D-015 的并发 append 窗口放弃本轮）
  - L2 L2 交付 reviewer run 终止（T1 补漏）：triggerDeliveryAudit 的 3 个 reviewer run 此前无记录无终止——登记 deliveryReviewerRuns，async-complete 完成即移除，session_shutdown 对挂起 run stop（reviewer 只读无 state 写，无双写风险）
  - T1 细化：session_shutdown 仅 stop 超 TTL 的 run（刚 spawn 的正常审计者让其在会话结束后收尾，JD#15 语义——pi 运行时实证 await async handler）
- 测试 49/49（+T2 截断游标/CJK 收敛/游标滞后保底 3 回归 +T3 清扫回归），tsc 0
- **本会话双审计（FP 专家 + Jeff Dean）交叉审查修复（1200s 延迟审查轮，3 路发现合并）**：
  - **乐观锁 read→stat TOCTOU（决策审计者 D-028 偏离项，run-55708 同结论）**：expectedMtime 在写时刻捕获而非读时刻——写者落在 read→stat 间隙时 `{...raw, ...state}` 用陈旧快照覆盖 fresh raw、verify-after-write 读回自身 payload 检测不到（08-13 signatureConvLine 改写事故同类）。新增 `readAuditStateWithMtime`（stat 先于 read 配对），patchAuditState/recordSignature 改走配对读；writeAuditState/appendDecision rename 紧前 mtime 复校验（stat→rename 窗口缩到 µs）
  - **appendDecision last-writer-wins 丢失窗口（双路共识 FP#3/JD#1）**：mtime 校验原在 tmp 写前——两写者均通过校验后交错 rename → 先写者条目静默丢失且双方返回成功。复校验移到 renameSync 紧前；补重试路径行为测试（写 tmp 期间 mtime 前拨触发重读重试——JD 审计 #2 指出的重试路径零覆盖）
  - **会话边界门禁覆盖泄露（FP#1）**：TTL 内新会话继承旧审计锁 → 首轮提交门禁被「窗口早于本会话提交」的遗留签名满足（auditRunId 匹配即放行）。resetForSessionStart 保留锁时覆写 auditRunId 为新鲜值 → 遗留签名必不匹配 → 门禁可见降级、下轮全量重审
  - **auditRunId 静默写失败（FP#2a）**：现网 auditRunId=""（spawn 后 patch 冲突静默 / 审计者首写基于旧快照覆盖回空）→ runId 身份校验整段空转。`persistAuditRunId`（返回值检查 + 落盘值验证补写 + warn/lastError 可观测），agent_end 与 /pair-audit 共用
  - **decision_add 字段消毒（FP#5a）**：换行可注入伪条目（parseChain 按行宽容解析）+ 无长度上限 → 链无界增长。appendDecision 单行化 + 截断（summary 200 / context·decision·rationale 1000 / alternatives 500）
  - **超时降级占位噪音（决策审计者实证）**：「审计开始：窗口=…」未命中精确 `"审计开始"` 过滤 → 降级 blockers 当价值点注入用户。改前缀匹配 + 补滤历史「审计触发失败」残留措辞
  - **A2 blockedStreak 路径补齐（FP#5c 核实）**：审计者按协议直写 signature（不走 decision_signoff/recordSignature）→ streak 不递增、A2 门禁（≥3 连续 blocked 降级）对审计结论不响应。门禁完成点按签名状态维护（passed 清零 / blocked 递增，cap 在 MAX 防混合路径双计）
  - **接受项（文档化取舍）**：decision_signoff 无 runId 可完成门禁（semi-by-design——signoff 工具即设计签名通道）；审计者 write 通道无乐观锁（扩展侧不可拦截，纪律约束 + 审计者 prompt 字段保留清单）；recordSignature 幂等对 auditStartedAt=0 恒真（实际调用面不触发）；超时重读 duration 起算点（CI 指标无行为影响）；JD#18 公共链模式排除 docs/decisions 的漏审面（hasNewCommit 覆盖）
- 测试 52/52（49 + 双审计轮 +3：乐观锁重试 / 字段消毒 / 会话边界 auditRunId），tsc 0

## [1.0.26] - 2026-08-14

泄露审计修复（函数式专家 + Jeff Dean 双视角交叉审计，独立 reviewer 验证闭环）：

- **L3 critical：signature.head 单位错配根治**——审计者 prompt 此前要求写 `git rev-parse --short HEAD`（短哈希），扩展 `gitHead()` 返回全哈希，`shouldInjectSignatureFindings` 严格全等比较 → 审计者手写的 blocked/passed-with-warning 签名**恒判定过时、永不注入**（跨会话重注入通道被反向打成永久静默）。统一为全哈希（prompt + agents/decision-auditor.md），head 消毒补 `typeof === "string"` 守卫；回归测试用真实 git 仓库锁定（全哈希注入 / 短哈希不注入）
- **L1 锁兑现：乐观锁从"纸锁"变真锁**——新增 `patchAuditState`（字段级 patch + 读最新 + mtime 冲突重试一次）；extension 全部 9 个写点改走它；锁获取点（agent_end spawn 前置、清残留锁、/pair-audit 前置）检查返回值，冲突失败跳过本轮 spawn 防并发双审计；`writeAuditState` 的 `{...raw, ...state}` 合并写 + `flush:true`（fsync）
- **L2 消毒丢字段 + 损坏覆盖机制修复**——writeAuditState 读磁盘原文合并保留未知字段（新增字段不再被任意写者消毒删除——gatedHead 丢失事故的机制根因）；损坏 state.json 先备份 `state.json.corrupt-<ts>` 再重建，防默认值覆盖真实审计进度
- **L4 auditFindings 双写者分离**——spawn 失败记账文本从审计者拥有的 `auditFindings` 改走扩展属主字段 `signature.reason`（防超时降级把它当价值点注入用户）；降级过滤补历史残留文本
- **minor**：waitForAuditCompletion 双 sleep → 单 sleep（300s 门禁内轮询次数翻倍）；清残留锁点返回值检查；死导入清理
- **双审计（FP 专家 + Jeff Dean）泄露清单全量修复**：
  - **critical#1 共享 tmp 名**：`state.json.tmp` 被所有写者共用 → 双写者交错互相覆盖/rename ENOENT/半成品落盘。tmp 名按写者唯一（`${file}.tmp-<pid>-<时间戳36>-<随机>`），rename 失败按冲突返回 false
  - **high#2 chain.md 无锁编号**：appendDecision read→parse→nextId→append 无乐观锁 → 并发写者重复 D-NNN。加 mtime 校验 + 冲突重试（3 次）+ 写后验证（内容一致 + id 唯一），仍冲突抛错不静默追加
  - **JD#14 门禁完成判定无 run 身份**：完成判定只比 `at ≥ startedAt` → 遗留/并发审计者签名可劫持新会话门禁结论。抽为 `isAuditCompleted` 纯函数：`state.auditRunId`（spawn 后写入）与签名 `runId` 同时存在时必须匹配；failed 永不视为完成；审计者 prompt/agents 收尾协议要求签名带 runId
  - **JD#15/FP#6 锁年龄条件**：resetForSessionStart 与 shouldClearStaleLock 无条件清 inFlight → 热重载后真审计运行中被释放 → 并发双审计。均加 auditStartedAt 年龄条件（仅超 TTL 才清）；IN_FLIGHT_TTL_MS 常量移到 lib 共用
  - **JD#16 mtime 乐观锁写后验证**：rename 后重读磁盘内容 ≠ 本次写入 → 冲突返回 false（patchAuditState 重读最新重试）——单次重试不覆盖检查-写入窗口内到达的写入
  - **JD#17 静默吞错**：agent_end 外层 catch noop → 错误整轮无痕（实证 prevBlockers ReferenceError 被吞）。改 console.error + state 新增 `lastError` 字段落盘
  - **JD#18 公共链自触发循环**：PI_PAIR_CHAIN_PUBLIC=1 时 chain.md 在 docs/decisions/ 未排除 → 每次 append 变脏 → 每轮 spawn。hasUncommittedChanges pathspec 追加 `:(exclude)docs/decisions`（仅公共链模式）
  - **JD#19 超时降级盲写**：300s deadline 与审计者签名间 ≤2s 盲窗 → 真实签名被 passed-with-warning 覆盖、blockers 永久丢失。降级前用 isAuditCompleted 重读再查一次，成立走正常完成分支
  - **JD#20 signoff 幂等**：recordSignature 无条件重写 at + blockedStreak+1 → 重复 signoff 去重键失效 + streak 双计。同轮同结论（status/blockers 相同且 at ≥ auditStartedAt）→ no-op
  - **JD#21 session_start 覆盖门禁基线**：新会话无条件以当前 HEAD 为基线 → 上会话门禁前终止的提交永不过审。保留持久化基线（`st.gatedHead ?? head`）
  - **JD#22 convlog O(n) 扫描**：convLogLineCount 每轮整读 3-6 次（实测 428KB/天）。按 (mtime,size) 进程内缓存，文件未变直接返回
  - **JD#23 中间态注入窗口**：新 spawn 后、审计者写占位前 auditFindings 仍是上轮结论 → 误标「被中断审计」注入。spawn 前置写清空 auditFindings
  - **FP#3 roundDecisionMade 泄漏**：append 前置位 + agent_end 不执行（print 模式/异常）→ 残留误触发。置位移到 append 成功后 + session_start 清零
  - **FP#8 recordSignature 内嵌 git IO**：状态转移内 exec git rev-parse，瞬态失败 → head:null → 兼容注入削弱新鲜度守卫。head 改调用方传入（缺省回退上一签名 head）
  - **FP#10 锁与 spawn 间异常**：patchAuditState 抛错残留内存锁。置锁→spawn 块 try/catch，失败释放双锁
  - **FP#13 门禁超时不终止 run**：超时降级后 rpc("stop") 终止仍挂着的审计者 run（stop 失败不影响降级放行）
  - **FP#7 跨会话 plan 决策丢失**：runId 过滤 vs 共享游标矛盾——其他 run 行中的明显决策仍提取入链（标注来源 run），推导目标仍只用本会话行
  - **FP low 组**：签名消毒重建字段保留（runId/reason/head 已全量）；waitForAuditCompletion 去循环内重复 duration 写；内存锁 TTL 换 performance.now() 单调钟（墙钟跳变不早/晚过期）
- 测试：45/45 通过（+3：isAuditCompleted 完成判定 9 态 / recordSignature 幂等 / appendDecision 无重复编号；接线守卫改断 isAuditCompleted 调用）、tsc 0 错误

## [1.0.25] - 2026-08-14

根治「新会话还有泄露」（用户报障：新会话开头仍自动出现审计结论——即使内容新鲜且属于本项目）：

- **跨会话注入去重持久化**：`injectedSignatureAt`/`injectedInterimAt` 从进程内存改为 state.json 持久化字段——同一审计签名/中间态**只注入一次**（审计完成后首个 turn 或 async-complete followUp 场景），之后所有新会话不再重复弹出；内存 map 优先（同会话去重）、热重载/新会话从 state 恢复（跨会话去重）；审计者 prompt 字段保留清单 + agents/decision-auditor.md 显式要求原样保留（gatedHead 教训复用）
- **followUp 同步记录去重**：async-complete 发送 blocked 缺口 followUp 时立即持久化 injectedSignatureAt——已即时交付的结论不在下个会话再注入一遍
- 测试：去重字段往返 + 消毒 + resetForSessionStart 不清除（跨会话存活）；39/39 测试通过、tsc 0 错误

## [1.0.24] - 2026-08-14

修复跨会话/跨项目审计串台（用户报障「会话刚开始就有个审计结果」+「为什么别的会话的审计会串台」）+ 审计缺口 L1-L7 全量修复（函数式 + 系统设计双视角交叉审计）：

- **注入新鲜度校验（跨会话泄露根治）**：signature 新增 `head` 字段（审计时的产物基线 HEAD）——before_agent_start 注入判据抽为 `shouldInjectSignatureFindings` 纯函数：当前 HEAD 已推进（修复提交落库但再审未跑）→ 签名过时 → 不注入陈旧 blockers；head 缺失（旧签名）兼容注入不丢交付。审计者 prompt + agents/decision-auditor.md 收尾协议要求签名必须带 head
- **failed 重试闭环（L3）**：hasWork 加 `signature.status==="failed"` 分支——提交轮 spawn 失败后产物已落库、uncommitted/newCommit 信号都假，不加此分支 failed 永不重审、产物永不过审
- **failed 保留 blockers（L2/L7）**：spawn 失败写 failed 时保留上轮 blockers（failed 是「未审」不是「无缺口」，整体覆盖会抹掉真实缺口/降级价值点）；findings 去重（L6，重试风暴不无限累积）
- **多实例守卫前移（L4）**：convlogForeignRuns 守卫先于残留锁清理——多实例场景 state.inFlight 可能属于另一实例，非属主实例清锁会让对方审计者收尾写冲突放弃、签名丢失
- **完成判定排除 failed（L5）**：waitForAuditCompletion 只认真实审计签名——多实例下 failed.at 可晚于本轮 auditStartedAt，不排除会劫持门禁完成判定
- **门禁失败可见信号（L1）**：提交轮 spawn 失败 notify 告知「产物未过审」，不静默放行
- **/pair-audit 纳入 inFlight 状态机（L3'）**：手动命令与自动审计共用锁 + 呼吸灯 + async-complete 持续交付（此前命令不写 inFlight → 并发双 spawn、灯被先完成者误灭）
- **gatedHead 审计者保留（reviewer 实证）**：审计者收尾写曾把 gatedHead 字段整个丢掉——prompt 字段合并纪律显式要求原样保留
- **非 git 根守卫（跨项目串台主通道）**：自动解析退化为非 git 目录（典型：home 目录）时 agent_end 跳过自动审计 + 每会话一次警告——审计基线=整个磁盘，无关项目产物被当成一个项目审（实证：fence-check 审计以 `C:\Users\Nuctori` 为根，结论写入 home 根 state 被其他会话注入）。显式 `PI_PAIR_PROJECT_ROOT`（用户权威根）与手动 `/pair-audit` 不受限
- **RUN_ID 会话级（同进程切会话内容混读）**：RUN_ID 从模块顶层移入扩展工厂——pi 的 loader 对同 cwd 缓存扩展工厂、模块顶层只执行一次，模块级 RUN_ID 会让同进程切会话时两会话行混标、A 会话的审计把 B 会话的对话当自己的；三个 prompt 注入点改传参（buildAuditTask/buildIncrementalAuditTask/DELIVERY_ANGLES）
- **convlogForeignRuns 按 pid 判并发**：外来判定从「run 标记不同」改为「pid 不同」——同 pid 不同 run（同进程切会话）不算并发实例，跨进程仍检出；旧格式 run 标记（无 pid 前缀）回退全等判定
- **failed 状态语义（M2）**：spawn 失败改签 failed（非假 blocker「审计触发失败，产物未过审」）——不递增 blockedStreak、不推进 signatureConvLine（产物未被审计覆盖，下轮 hasWork 自动重试）、不注入假缺口；stale 锁清理/TTL 过期同步灭灯（防呼吸灯永久常亮——实证 7220s 卡灯）
- 测试：38/38 通过（shouldInjectSignatureFindings 行为级 7 态 + pid 判定 + 非 git 根守卫/RUN_ID 会话级接线断言 + gatedHead 往返 + failed 语义）、tsc 0 错误

## [1.0.23] - 2026-08-14

修复「陈旧 blocked 签名反复注入每个新会话」根因（用户报障：会话刚开始就有个审计结果——实证为 08-13 修复提交后再审永不触发，已修复的 blockers 在 state.json 挂 14h+ 反复注入）：

- **门禁基线持久化（M5）**：`gatedHead` 从纯内存改为 state.json 持久化字段——扩展热重载（`/reload` / `pi install`）重置内存 map 后，惰性初始化从 state 恢复上次门禁覆盖的 HEAD，不再把热重载后刚提交的修复吞成基线（`hasNewCommit=false` → 修复轮永不自动再审 → 陈旧 blocked 签名跨会话反复注入；实证：08-13 21:04 审计者签 blocked 两缺口 → 21:06 修复提交 2a0b55b → 之后无审计者 spawn，16:28 与次日会话开头各注入一次过期 blockers）。旧状态无字段时回退当前 HEAD（保持「无提交不触发门禁」语义）
- 接线点：session_start 持久化 + agent_end 惰性初始化恢复（先于 hasNewCommit 计算）+ 门禁完成/超时降级后推进
- 测试：gatedHead 读写往返 + 消毒 + M5 位置守卫；35/35 测试通过、tsc 0 错误

## [1.0.22] - 2026-08-13

TUI 审计状态呼吸灯（用户要求：审计在 agent_end 后异步运行，状态无感知）：

- **呼吸灯**：spawn 审计者成功 → TUI footer 显示转圈帧 + 已运行秒数（`- 结对审计进行中（5s）`，1s 刷新）；灭灯出口全覆盖——审计完成（async-complete）/ 门禁签名完成 / 300s 超时降级 / spawn 失败 / 会话结束。用 pi 原生 `ctx.ui.setStatus`，零新依赖（否决 pi-tui 组件：引入依赖 + 复杂度）
- **多语言**：`PI_PAIR_LANG=en` 切英文（最小双语，不引 i18n 框架——现有 notify/findings 文案仍为中文，全量 i18n 另立）；README 中英环境变量表同步
- **cwd 隔离（D2）**：async-complete 灭灯传完成审计的 cwd，仅当与亮灯 cwd 匹配才灭——多实例并发审计时先完成的审计不会误灭后启动审计的灯
- **ASCII 帧（D-026）**：spinner 帧从 braille（⠋⠙⠹）改为经典 `- \ | /`——braille 在部分终端/字体下渲染为方块乱码（用户报障「飙奇怪文字」），ASCII 任何终端零兼容问题
- 34/34 测试通过、tsc 0 错误；D-025/D-026 入链（呼吸灯 + 双语 + ASCII 帧）

## [1.0.21] - 2026-08-13

修复残留锁假挂起（用户报障：自动唤起看似没工作——实证为 17:41:45 提交轮 spawn 中断后 state.json 假 inFlight 挂 2.5h）：

- **残留锁兜底上移**：agent_end 的清残留锁逻辑从 `hasWork` 判断之后移到之前——纯咨询轮 return 前也会清锁（清锁≠spawn，不违反零噪音承诺）；防「spawn 中断后 inFlight=true 永久残留」让 state.json 一直显示假审计中
- **顺带修复旧快照 bug**：清锁后重读 state——原实现清锁后 spawn 分支仍用旧快照（inFlight=true）判断，清锁轮会跳过 spawn（残留锁释放后本轮不审计）
- 31/31 测试通过、tsc 0 错误

## [1.0.20] - 2026-08-12

修复 3 个审计边界（D-017 落地）：

- **边界① 交付检测：词表 → 客观提交信号**：删除 `DELIVERY_SIGNAL_RE` 词表与问句排除——「完工」是语义判断，模式匹配不可靠（v1.0.17 废弃 hasNewDecisionSignals 的同款结论；词表漏检 + 问句误伤「完成了吗」卡 300s 双缺陷）。改为 **git HEAD 变化**（`gitHead` + 会话级 `gatedHead` 基线）：本轮产生了提交 = 交付发生的客观事实，问句/任意措辞天然免疫；门禁与 L2 交付审查同源触发；非 git 仓库无门禁（异步审计照跑）
- **边界② 修复轮 diff 漂移**：审计任务 prompt 加 blockers 可操作规范（文件 + 基线行号 + **独立于行号的问题描述**——行号会漂移，描述是重定位锚点；末尾附 git HEAD 短哈希 + 未提交文件列表作基线）；新增修复轮核对步骤（上轮 blocked → 逐个核对旧 blockers 在新产物中是否仍成立，未修复的重报，不得因产物演进而漏掉）
- **边界③ 会话早结 findings 丢失**：`shouldInjectInterimFindings` 判据放宽——`inFlight===true`（被杀锁残留）或 `signature===null`（审计未收尾，会话早结被杀后新会话 reset 清 inFlight 的跨会话交付）；纯咨询占位（`PURE_CHAT_PLACEHOLDER`）过滤后不算真实中间态（零注入承诺保持）；注入文案标注「可能来自上次会话」
- **边界④（实证修复）审计对象错位**：审计任务第三步的审计对象从「未提交 git diff」改为「上次审计（lastAuditAt）后的已提交窗口 + 未提交 diff」——快节奏每轮提交时未提交 diff 常为空，原定义让已提交产物永不过审（实证：follow_me v22-v28 产物 signature=null）；交付轮等的审计者现在审的是不变的历史窗口 + 当前 diff，不再因产物漂移而过时；超时降级的 blockers 改用审计者已确认的 auditFindings（价值点），无 findings 才给超时提示（实证：InitDeity 8 条真实 findings 曾被「审计超时」流程文案替换）；注入文案区分 passed-with-warning（「部分发现供参考」vs blocked 的「请修复缺口」）
- 文档同步：audit-state-machine.md T1（门禁产物前置）、T2（超时降级 blockers=findings）、T4（新判据）、状态表 auditFindings 占位语义
- 测试：`shouldInjectInterimFindings` 纯咨询模拟改为占位（inFlight=false + 真实 findings 语义已变为跨会话注入）+ 新增 2 态（会话早结残留→注入 / passed 残留→不注入）；`gitHead` 行为（非 git→null / init+commit→HEAD / 新提交→HEAD 变化）
- **审查修复轮（审计者 + 3 reviewer 发现）**：① prompt `--since` 单位矛盾（lastAuditAt 毫秒喂秒 → 空窗口 → 复现边界④缺陷）→ 明确 ÷1000/ISO；② `hasWork` 判据加 `hasNewCommit`——提交后 diff 空 + 审计者可能推进对话游标 → 两便宜信号都 false → 提交轮早退绕过门禁（安全审查 Medium）；③ L2「正确性」reviewer prompt 同步为已提交窗口（L2 层已提交产物永不过审残留）；④ L2 fanout 移到多实例守卫之后（多实例场景不再白跑 3 reviewer）；⑤ `auditFindings` 每轮**替换**为占位（清旧轮陈旧内容——超时降级把 findings 当 blockers 注入时不再污染价值点）；⑥ 审计者收尾前检查主进程降级签名（passed-with-warning 已存在 → 不写签名，防超时竞态覆盖真实结论）；⑦ 陈旧注释清理（词表时代残留/L0 命名/lib 头注释/test 缩进）；D-019~D-022 入链（canGateOldAudit 删除/审计对象重定义/降级 blockers=findings/git HEAD 门禁）
- **发布前修复轮（审计者 + 3 reviewer 终审）**：⑧ `gatedHead` 惰性初始化——扩展热重载（/reload）不重发 session_start → map 空 → 「无提交也触发门禁+L2」误触发（实证：未提交却 spawn 3 reviewer）；首次 agent_end 建基线不门禁；⑨ 门禁等待 UI 告知（提交轮同步等审计时用户可感知，≤300s）；⑩ 审计窗口起点改用 `signature.at`（上次审计完成时间）+ **spawn 块不再覆盖 `lastAuditAt`**（原覆盖为当前时间 → 本轮提交全在窗口外 → HIGH find#1）；⑪ 收尾跳过签名条件收紧为「`passed-with-warning.at ≥ 本轮 auditStartedAt`」（陈旧降级不跳过——否则签名流永久停滞）；⑫ 超时降级 blockers 过滤启动/纯咨询占位；⑬ `gitHead` 加 5s 超时（与 hasUncommittedChanges 一致）；⑭ version bump 1.0.20
- **纯咨询轮零 spawn（用户实测污染）**：对话增量触发收紧为「增量 **且 本轮调用了 decision_add**」——纯咨询问答轮（含非 git 目录如用户主目录）不再 spawn 审计者（此前每轮 spawn + 后台完成通知 = 体验污染；零噪音承诺从「零注入」升级为「零 spawn」，D-006 语义扩展）；git 产物/提交仍无条件触发；plan 决策经 decision_add（skill 既有要求）触发审计者提取入链
- 31/31 测试通过、tsc 0 错误

## [1.0.19] - 2026-08-12

L2 交付审查（3 个 fresh reviewer）复审 v1.0.18 后的修复轮——无 blocker，处理 2 Medium + 4 Low：

- **clamp 落盘竞态（Medium）**：`clampConvExtractedLine` 改为纯读（不落盘）——原实现在谓词求值中做 state.json 读-改-写，与异步审计者进程形成竞态（窄窗口可覆盖刚写入的签名）。钳制落盘合并进 agent_end 的两个既有写点（残留锁释放 / spawn 前全量写）
- **B5 代码级兜底（Medium）**：`waitForAuditCompletion` 完成判定补 `at===0` 分支——审计者手写 signature 漏 `at`（消毒为 0）时，用 `lastAuditAt >= startedAt` 判定刚签名完成（收尾写必置 lastAuditAt；旧轮无 at 签名不会被误判），交付轮不再 300s 超时覆盖真实结论
- **B1 行为级测试**：注入判据抽为 `shouldInjectInterimFindings` 纯函数（lib），扩展 handler 调用它；4 态行为测试（被杀→注入 / 同轮去重 / 纯咨询零注入 / 无 findings）替换字符串守卫
- **中间态 inFlight 保真**：审计任务 prompt + agent 协议明确「中间态写入必须保留 inFlight=true，仅收尾签名写 false」——防止审计者提前释放锁导致被杀后 findings 无法注入交付
- **Low 清理**：CHANGELOG 重复 `# Changelog` 头（v1.0.18 引入的回归）、README 英文设计哲学两处对齐 D-011（chat-only quick-exit 语义）、agents/decision-auditor.md 删除不可达的 decision_signoff 优先推荐（工具不在 tools 列表）
- 30/30 测试通过、tsc 0 错误

## [1.0.18] - 2026-08-11

项目自审修复轮（决策链 D-011~D-015 已捕获 v1.0.16/v1.0.17 变更）——6 个真实缺口：

- **B1 纯咨询轮零注入承诺被打破**：中间态注入判据 `(inFlight || !signature)` 会把纯咨询轮的「本轮纯咨询，无审计对象」占位当作"审计被中断"注入 display:true（signature=null 的新项目首轮咨询必现）。改为 `state.inFlight === true`（审计在跑 = 真中断；纯咨询轮主动写 inFlight=false → 零注入）
- **B2 对话增量触发可静默断线**：convExtractedLine 单位不一致——审计者按 read 文件行号推进、扩展按 convLogLineCount（只计对话行）比较，审计者写超即断线（本仓实证 578>471）。新增 `clampConvExtractedLine`：agent_end 触发前钳制为对话行总数并落盘；审计任务 prompt 两处明确"对话行计数，非文件行号"
- **B3 权威文档自相矛盾**：signatureConvLine 语义代码（recordSignature 恒推进）与文档（blocked 不推进）冲突，且 H2 后 agent_end 已不读 convLine、L140 括号理由失效。统一为"**签名即推进**"（修复走 blockers 注入通道）——改 audit-state-machine.md T2/不变量 1/6、architecture.md、agents/decision-auditor.md、审计任务收尾文案
- **B4 判据文案过期**：README 中英「pure chat → no audit」/「不 spawn 任何 run」、architecture.md「不做 L2 交付审查的分层」与代码保留的 triggerDeliveryAudit 矛盾、lib 注释 entriesSinceLastAudit 残留、CHANGELOG 重复行——全部对齐 v1.0.16 触发判据（git 产物 or 对话增量 → 审计者 AI 判定）
- **B5 审计者手写 signature 缺 at 字段**：扩展按 `signature.at ≥ auditStartedAt` 判定审计完成，但收尾 prompt 未要求写 at → 交付轮会把真实结论误判为超时并覆盖。收尾 prompt + agents/decision-auditor.md 明确 signature 必须带 `at`（= lastAuditAt）
- **P1 自动审计永久停摆（多实例守卫误杀历史会话）**：`convlogForeignRuns` 旧语义统计 convlog 全部历史外来行，而 convlog 按 cwd 永久追加、RUN_ID 每个进程不同 → 第二个会话起守卫恒 >0，agent_end 自动审计（含修复轮复审）永久跳过，blocked 签名永不更新、过期 blockers 反复注入（实证：本仓 165+97 行历史 run 标记导致 B1-B5 修复轮复审从未触发）。修复：只统计本实例首行**之后**的外来行（并发交错窗口）——历史行不算；并发检测一侧命中即足够（先启动方必然看到后者的交错行）。P1 回归测试锁定
- 新增守卫断言（B1/B2/B3/B5 各一条）+ clampConvExtractedLine 单测 + P1 回归用例；29/29 测试通过、tsc 0 错误

## [1.0.17] - 2026-08-11

审计核实升级——两层核实（收敛 + 可控发散）：

- **收敛核实**（原有）：对账——声明的每个事实 vs 代码/仓库一致（不信任记录，事实不符 = 偏离 ✗）。只证明「声明的没错」
- **发散核实**（新增，对抗式的另一半）：在目标/决策/产物三个锚点内主动找未声明的风险，6 类攻击点：a) 未声明的假设 b) 被忽略的替代方案 c) 边界反例 d) 跨层盲区 e) 二阶效应 f) 跨领域知识迁移（把其他领域/项目/范式中同类问题的已知失败模式迁移审视——缓存穿透/竞态/状态机遗漏/规模拐点；与 CAP/ACID/幂等/背压等成熟范式的偏差是有意取舍还是无知）
- **可控边界**：每个发散点必须落回「产物/决策的某个具体缺口」才计为发现（偏离 ✗）；落不回的猜想写进 auditFindings 供参考，不硬算 blocker
- 发散核实与收敛核实同等权重（找到 = 偏离 ✗）；守卫测试锁定两层核实存在
- 28/28 测试通过、tsc 0 错误

## [1.0.16] - 2026-08-11

plan 阶段审计修复——决策信号交给 AI 判定，不做模式匹配：

- **触发判据改为两个便宜信号**：`hasUncommittedChanges(root) || hasNewConversation(root, convExtractedLine)`——git 产物 or 对话增量（无语义理解，任何会话有真实交互都触发）
- **语义判断移给审计者（第零步）**：审计任务先 AI 判定本轮有无值得审计的工作——纯咨询 → 快速退出（推进 convExtractedLine、写 auditFindings=["本轮纯咨询，无审计对象"]、不写 signature、零注入）；plan 阶段（有决策无 git 产物）→ 提取决策入链 + 审决策质量；实现阶段 → 审产物
- **废弃正则信号词判据**：`hasNewDecisionSignals`（PROCESS_SIGNAL_RE 模式匹配）删除——"那我们就用 B 吧"类真实决策不命中信号词会漏检，模式匹配无法可靠识别决策
- **修复 follow_me 式漏审**：非 git 目录有真实开发（src/*.js）→ 对话增量触发 → 审计者审；纯咨询非 git（问答）→ 审计者判无工作退出
- 新增单测：`hasNewConversation`（无对话/有对话/游标推进/新对话四态）+ 守卫断言（第零步判定存在、纯咨询退出路径存在）
- 28/28 测试通过、tsc 0 错误

## [1.0.15] - 2026-08-11

交叉审计修复（发布前）——3 个真缺陷 + 文档残留全清：

- **H1 inFlight 锁泄漏**：`recordSignature` 置 `inFlight=false`（签名=审计结束）——防 decision_signoff 路径泄漏锁导致该 cwd 审计永久停摆
- **H2 blocked 误判超时**：`waitForAuditCompletion` 完成判定改为"本轮新签名（signature.at ≥ auditStartedAt 且 !inFlight）"——blocked 签名（不推进 signatureConvLine）也被识别为本轮结论，交付轮不再把真实 blockers 误判为超时并覆盖
- **M2 交付标记泄漏**：`deliveryRequested.delete` 提前到 agent_end 最前（任何早退路径都不泄漏到下轮）
- **M3 L2 门禁硬编码**：reviewer/审计任务文本的 `docs/decisions/chain.md` 改为动态 `chainPath(cwd)`（默认 `.pi/decision-auditor/chain.md`）
- **M4 残留锁兜底**：agent_end 对"文件锁 inFlight=true 但内存锁无"（审计者被强杀）补释放——防审计永久停摆
- **文档全清**：README 中英（How-it-works/Capabilities/环境变量表/设计要点）、agents/decision-auditor.md（生命周期/查询协议/收尾幽灵字段）、docs/audit-state-machine.md（状态表/T4/T6/测试锁定）、CHANGELOG 内部矛盾段——全部对齐 fresh spawn + 单层审计最终架构
- 26/26 测试通过、tsc 0 错误

## [1.0.14] - 2026-08-10

convlog 会话隔离（多实例混写防护）——修复同 cwd 多 pi 实例共享 convlog 导致审计者把其他会话的对话当本会话决策捕获（实证：D-060~D-062/D-064 的触发来自另一开发会话的用户消息）。

### 会话隔离（D-065 落地 + reviewer 复审修复）

- `appendConv` 行尾 `<!--run:<id>-->` 标记（实例级 RUN_ID = pid+random）；process.md 意图信号同步打标
- 4 处审计/L2 prompt 注入过滤规则：提取决策/推导目标只依据本会话标记行；无标记行（升级前历史）仅作上下文、不提取；其他 run 标记行忽略
- 多实例混写检测 `convlogForeignRuns`：agent_end/agent_settled 检测到其他实例真实对话 → 跳过自动审计 + warning（run 级过滤 vs 全局状态机错配时显式降级，不静默错审）
- 接线守卫静态断言（写入点传 RUN_ID、4 处规则注入、多实例检测接通）+ 新增单测（runId 隔离、外来 run 检测）
- 31/31 测试通过，tsc 0 错误

### 审计预算调整（180s→300s / 720s→600s）+ 伪造标记修复

- 阻塞等待上限 180s→300s，协商关闭窗口 720s→600s（演进中间态；最终架构删除协商窗口——超时直接降级放行，见下方架构重构）
- 文案同步：steer 协商消息、超时 blockers、注释、审计者规约（约 120s→约 300s）、README/SVG 一致化（原 120s 声明 v1.0.12 起即过期）
- `convlogForeignRuns` 正则锚定行尾（`/<!--run:...-->\s*$/`）：真实标记由 appendConv 追加在行尾，防用户正文内嵌伪造标记误判外来实例（可永久关闭审计门禁）；新增回归单测

### 架构重构：单层审计 + fresh spawn（根治机制叠加）

- **砍 L0 独立层**：删除 `spawnL0Audit`/`buildChainAuditTask`/`accumulateRound`/`checkAuditDue`/`AuditConfig`——单层审计一次任务完成"提取决策 + 审产物 + 签名"，agent_end 按真实产物判定直接触发，无累积记账/节流
- **砍常驻 run**：删除 `ensureAuditorInLane`/`residentAuditorRunIds`/resume 复用/`auditorRunId` 字段——每次 fresh spawn（`context:"fork"` 继承主会话上下文），审计完即死，session_shutdown 只清内存锁
- **状态精简**：`AuditState` 从 13 字段减到 9（删 `roundsSinceAudit`/`pendingChars`/`chainFindings`/`auditorRunId`）——单层审计无独立链维护通道
- **L2 前置门禁**：`triggerDeliveryAudit` 前检查真实产物（git 改动 or 决策条目）——无交付物不 spawn reviewer，杜绝 follow_me 式空转（reviewer 无产物反复搜索）
- **注入收敛**：`before_agent_start` 只保留价值点（blockers/auditFindings）`display:true` 注入，删除 chainFindings 内部通道（display:false 分支）
- 代码量：扩展 1114→907 行、lib 712→607 行、测试 32→26（删 L0 记账/节流测试，新增单层架构守卫 + auditFindings 消毒）
- 26/26 测试通过、tsc 0 错误；`docs/architecture.md` 记录目标架构与设计原则

### 体验改造：结对"真实有效、好体验、无感"（根治审计感知过强）

- **真实产物判定**：agent_end 触发判据从"convlog 有增量"改为"git 未提交改动 or 未审计决策条目"——纯咨询/运维会话（无代码产物、无决策）零审计零噪音，消灭"没有产物也走审计"
- **常规轮异步不阻塞**：agent_end 常规轮 spawn 审计者后立即返回（不再 await 300s）；审计者完成写 signature，下一轮开工时经 `before_agent_start` 注入 findings
- **交付轮保留同步门禁**：用户消息含交付信号（提交/发布/merge/交付/收工/上线/部署/推送）→ agent_end 同步等签名（300s 上限）；超时降级放行 + 缺口注入下轮，不再 600s 协商黑洞
- **findings 注入替代刷屏**：blocked/超时结论经注入主 agent，用户不再看到"审计未通过（第 N/3 次）"流程刷屏；签名变化才注入（内存去重）
- 删除 `negotiateStop`（600s 协商窗口）与 `handleBlocked` 的 `sendUserMessage` 刷屏路径；A2 连续 3 次 blocked 降级放行保留
- **持续交付（R5）**：审计者边审边写 `auditFindings` 中间态到 state.json（启动即写占位、每步核实即追加）——中途被杀/超时也交付已确认的价值；审计完成（async-complete）时若 blocked → 立即 `sendUserMessage` 交付主 agent 处理（不等下轮注入）；修复 → 再审 → 直到干净
- **完成即停（R7）**：审计者签名后立即停止（prompt 明确边界），遗留疑问写 blockers/auditFindings 留给下一轮结合用户需求继续
- **状态目录排除（R11）**：`hasUncommittedChanges` 用 pathspec 排除 `.pi/`、`.pi-subagents/`（审计自身写入不算产物，防自触发）
- **价值点可观察**：审计抓出的缺口（blockers/auditFindings）`display:true` 注入——用户感知价值（最终架构：链维护内部通道已随 L0 层删除）
- **状态机文档化**：新增 `docs/audit-state-machine.md` 为权威状态转移定义（T1 触发 / T2 收尾 / T3 持续交付 / T4 注入 / T5 生命周期 / T6 recordSignature + 6 条不变量）；移除死状态 `timeout`（类型、streak 逻辑、测试同步清理——超时直接降级 passed-with-warning）
- 注入去重拆分：signature 结论与中间态各自独立去重 map（防互相覆盖重复注入）
- 新增单测：`hasUncommittedChanges`（非 git/干净/改动/未跟踪/状态目录排除五态）、接线守卫更新（fresh spawn 无 L0/常驻、async-complete 持续交付、完成即停、真实产物判定、交付标记先消费、异步不阻塞、价值点 display:true、L2 真实产物门禁、协商黑洞移除、刷屏移除）

## [1.0.13] - 2026-08-10

收敛回"一个结对审计者"（单一权威 state + L0/L1 同一 run）。

### 背景（用户批评，D-059）

双 state 分裂（C: 与 D: 两棵树各自记账）+ L0/L1 两个独立 spawn——违背"一个持灯人连续在场"的结对语义，成本语义上像"两个 agent"。

### A: 单一权威 state

- `resolveProjectRoot` 支持 `PI_PAIR_PROJECT_ROOT` 显式权威根（跨盘符场景——向上探测限于祖先链，C:\ 会话 + D:\ 项目必须显式指定）
- 扩展层会话级 `projectRoot` 缓存：session_start 解析一次固定，session_shutdown 重置；40 处 handler 调用点统一改用（杜绝同一会话双树）

### B: L0 复用 L1 常驻 run

- `spawnL0Audit` 不再 fresh spawn：`state.auditorRunId` 存在则 `resume` 同一 run（共享 L1 过程上下文 + 命中 prompt 缓存）；首次才 spawn 并记 runId——一个持灯人，两种职责，不新增实例

### 其他

- 协商关闭文案同步 120s→180s（steer 消息 + blockers 文案）

### 测试

- 28 单测通过（新增：resolveProjectRoot 显式权威根测试；接线守卫更新——projectRoot 缓存存在、无裸 resolveProjectRoot(ctx.cwd)、L0 resume 复用、PI_PAIR_PROJECT_ROOT 支持）

## [1.0.12] - 2026-08-10

- 审计预算调整：阻塞等待 120s→180s，协商关闭窗口 30s→720s（尽可能走协商关闭，确保审计真能审出东西）；总预算 900s < 960s TTL

## [1.0.11] - 2026-08-10

- README 社区级重构（中英）：badges/TOC/痛点叙事/快速开始/已知限制/Roadmap

## [1.0.10] - 2026-08-10

审计 prompt 优化（实证盲区维度）+ 路径提示修复。

### 实证盲区校准（同模型审计的教训）

审计系统用两个真实缺陷校准 prompt：①L0 累积断线（机制存在但 message_end 未接线——用户发现）②print 模式 handler 被丢弃（审计不阻塞——CI 跑分发现）。同模型审计均漏掉。

- **维度⑥ 机制完整性**：审含触发机制的产物时，验证触发链路每一环有实际调用点且可达（事件→函数→状态写入），防死代码/断线
- **维度⑦ 运行时行为 vs 声明**：产物声称"阻塞/异步/完成后 X"时，验证 print/TUI/RPC 各模式行为一致或明确标注差异
- 审计者协议 + L1 任务文本同步；接线守卫测试断言两个维度存在（防 prompt 退化）

### 路径提示修复

- 审计任务路径检查增强：指定链路径可能因 cwd 解析不准而缺失，明确引导"用 find 定位真实项目根下的链，实际位置为准"（D-036 审计者标注的遗留）

### 测试

- 27 单测通过（接线守卫 +3 断言）

## [1.0.9] - 2026-08-10

- auditStartedAt 提前到 spawn await 前写（print 模式 handler 可能被丢弃，duration 丢失）+ catch 释放 inFlight 锁
- bench 加进程级耗时测量（process_ms，不依赖扩展 handler 存活）

## [1.0.8] - 2026-08-10

- 审计阻塞时长写入移到 waitForAuditCompletion 轮询循环内（print 模式 handler 尾段不执行，原 recordAuditDuration 写不到）

## [1.0.7] - 2026-08-09

过程日志（意图信号）+ CI 跑分对比——强化 pair 通信，缩短 agent_end 阻塞。

### 背景

agent_end 阻塞的根因：审计者每轮被唤起时只有 convlog（最终回复）+ diff，需要**从产物反推意图**（最耗时）。

### 修复：过程日志（高信号过滤，成本≈0）

- **process.md**：只记 assistant 回复中命中**决策信号词**（决定/采用/放弃/方案/架构/重构/改为/引入/移除 等）的摘要（≤200 字符）；不记工具调用流水（避免膨胀）；超 100 条滚动截断（保留最近 50）
- **频率不变**：不增加审计者唤起次数（L1 每轮 + L0 攒够，同现状）——增加的是单次唤起的通信密度
- **L1 审计任务**加"读 process.md 意图轨迹，审产物时对照过程"步骤——审计者从"反推意图"变"对照意图"，阻塞时间降、准确率升
- `PI_PAIR_PROCESS_LOG=0` 可关闭（CI 跑分基线用）
- **阻塞时长测量**：agent_end 记录 `lastAuditDurationMs`（触发→签名），CI 跑分指标

### CI 跑分

- E2E 加 bench 步骤：同代码库两次跑（PROCESS_LOG=0 基线 vs =1 方案），提取 lastAuditDurationMs 对比
- 单次采样有模型噪声，结论看趋势（快/持平/慢）

### 测试

- 27 单测通过（新增：信号词命中/未命中、200 字符截断、滚动截断、lastAuditDurationMs 消毒、接线守卫补充 process 接线）

## [1.0.6] - 2026-08-09

恢复 L0 分层（链维护批量审计）+ 测试门禁（防断线回归）。

### 背景

1.1.0 设计的"增量累积唤起"（每轮记账、攒够 6 轮/8000 字符才审）自 1.4（agent_end 阻塞门禁）起**断线**：`maybeAutoAudit` 只在 `decision_add` 里被调用，message_end/agent_settled 无自动触发点；且 L1 审计者收尾会清 `roundsSinceAudit/pendingChars`——L0 永远攒不够。

### 修复：L0/L1 分层

- **L0 链维护**（非阻塞、批量）：`message_end` 每轮 `accumulateRound` 记账（零成本）→ `agent_settled`（L1 门禁之后）`checkAuditDue` 达阈值 → spawn 链维护审计：批量捕获增量决策入链 + 对抗式链级复审（五维度）→ findings 写 `chainFindings` → `before_agent_start` 低优先级注入主 agent
- **L1 产物门禁**（每轮、阻塞）：去捕获（决策入链归 L0），只审本轮产物（对抗五维度）+ 签名门禁；收尾**不清** roundsSinceAudit/pendingChars（归 L0 管）
- **L0 独立内存锁**（`l0AuditsInFlight`）：不占 state.inFlight（L1 的锁），避免 L0 抢 L1 阻塞窗口/签名语义混淆
- `decision_add`（手动）force 触发 L0 链维护审计
- `accumulatePending` 拆为 `accumulateRound`（只记账）+ `checkAuditDue`（判断+清零+返回）

### 测试门禁（防再次断线）

- L0 记账+判断：batchRounds / batchChars / minInterval / force / inFlight 全覆盖
- **分层隔离**：L1 收尾不清 L0 记账（roundsSinceAudit/pendingChars 保留）
- chainFindings 读写与消毒
- **接线守卫**：静态断言扩展源码含 message_end→accumulateRound、agent_settled→checkAuditDue+spawnL0Audit、L1 收尾不清记账、decision_add→force L0——断线直接 CI 红
- 23 单测通过（新增 6）

## [1.0.5] - 2026-08-09

对抗审计（优雅性五维度）——普通轮次从验证式升级为对抗式。

### 核心：产物默认有缺陷，逐维度尝试推翻

- **立场**：guilty until proven innocent——不"检查有没有错"，而是主动尝试推翻；五维度全部无法推翻才判 passed
- **五维度进攻清单**：① 原子性（独立评审/回滚？混入无关主题？决策链条目自足？）② 正确性（逻辑/边界/错误路径真的对？事实与仓库一致？）③ 一致性（决策间/实现与决策/既有模式一致？）④ 内聚（一个决策一个主题？职责放对？过度设计？）⑤ 完备（边界/错误/依赖/文档/测试覆盖？关键取舍入链？产物执行了决策？）
- 任一维度找到具体缺陷 → blocked（blockers 可操作）；全维度无法推翻 → passed
- 链基础检查（推理有效性/完整性/校准/Supersedes）保留为前置
- 成本 = 0：同一次审计，检查清单更专业（对抗立场 + 结构化维度，不新增 agent/调用）

### 动机

普通轮次原为验证式（检查产物是否执行决策）——单向、易走流程、同构偏见（审计者与主 agent 同模型共享上下文，天然倾向同意）。对抗立场 + 优雅性维度把审计变成"主动找茬"，收益显著提高。

## [1.0.4] - 2026-08-09

README 中英拆分 + CI E2E 真实路径验证。

### 文档

- `README.md`（英文）+ `README.zh-CN.md`（中文）拆分，顶部互相链接（社区标准做法）
- package.json description 改为英文（国际惯例）

### CI E2E 真实路径验证

- 新增第二个 E2E 场景：主 agent 做真实工作（创建 calculator.py）→ `agent_end` 阻塞审计签名闭环验证：
  - convlog 捕获用户提示 + 助手回复（捕获路径）
  - 审计签名发生（state.signature.status 非空——agent_end → 审计者 → 签名真实跑通）
  - 锁释放（inFlight=false）+ blockedStreak 追踪
- 验证结果：签名 blocked（门禁拦截）→ WARN 不失败（机制工作的证明，非断言目标）

## [1.0.3] - 2026-08-09

协商中止（negotiated stop）：审计超时后不直接 kill。

- 超时（120s）→ steer 通知审计者协商：把当前已发现的问题提前签成 blockers（主 agent 立即修复）——提前获知问题的通道；确认无问题则签名 passed
- 30s 协商收尾窗口；无响应才兜底 stop（防止窗口外继续跑）
- 审计者协议加"协商中止规约"（窗口约束的一部分）

## [1.0.2] - 2026-08-09

严格门禁 + 当场修复循环 + 窗口内通信（A2/B1/C1 设计）。

### 核心：审计是 end 的前提，缺口必须当场修

- **B1 阻塞门禁**：`agent_end` 阻塞等审计结论，**passed 才 end**；blocked → `sendUserMessage(followUp)` 触发当场修复轮 → 修复轮 `agent_end` 再次审计 → 直到 passed。用户不再收到"先完成、后纠正"的假声明——主 agent 一直工作到审计通过。
- **A2 降级退出**：连续 blocked 达 3 次 → 签名降级 `passed-with-warning` 放行（`ctx.ui.notify` 警告）——**end 就是 end**，不无限修复循环。
- **C1 窗口内通信**：审计者只在 agent_end 阻塞窗口内 `contact_supervisor`（60s 未回复即放弃，按证据给结论）；超时后扩展尝试 `stop` 审计者 run（防窗口外唤起主 agent）；跨会话疑问不残留机制——下一轮 AI 有完整上下文，会自己问。
- 审计任务/审计者协议：明确"本轮产物已完整，直接给结论"；修复轮先验证上轮 blockers 是否已修复再判定；blocked 的 blockers 必须具体可操作。

### 新增

- `blockedStreak` 连续 blocked 计数（blocked/timeout +1，passed/降级清零）
- 签名状态 `passed-with-warning`（A2 降级放行）

### 测试

- 19 单测通过（新增 blockedStreak 递增/清零/降级）

## [1.0.0] - 2026-08-09

**首个正式发布**（npm 包名为 `pi-pair`）。此前 1.1~1.6 为内部开发迭代，本版合并为 1.0.0。

提供**常驻结对审计**：每个会话自动带上一个独立审计者（"举灯人"），持续持有目标、对照决策链交叉审计每一轮产物，agent 结束时必须通过审计签名。

### 核心能力

- **常驻审计者（resume 复用）**：首次 spawn 记录 runId，后续 resume 同一个 run（带 session 历史，命中 prompt 缓存，比 fresh 全量重发便宜）
- **产物必须交叉审计**：`agent_end` 阻塞等待审计签名——未经独立审计的工作不能"结束"（120s 上限，spawn 失败标记 blocked 不静默）
- **不靠主 agent 自觉**：决策从对话日志提取（`convExtractedLine` 去重）、事实从仓库核实，审计者独立完成
- **决策链**：默认 `.pi/decision-auditor/chain.md`（私有，不污染 git）；`PI_PAIR_CHAIN_PUBLIC=1` 写 `docs/decisions/chain.md`（团队可见）
- **cwd 自适应**：`resolveProjectRoot` 从任意目录定位真实项目根
- **交付深度审查**：用户说提交/发布/merge 时，并行 fanout 3 个 fresh reviewer（正确性/目标一致性/安全健壮性）
- **工具**：`decision_add` / `decision_list` / `decision_signoff` / `/pair-audit`

### 测试

- 18 单测 + tsc + CI（unit + E2E opencode 免费模型）全绿

### 开发历史（1.1~1.6 迭代要点）

- 1.1 捕获不靠主 agent、增量累积唤起（参数经 205 历史会话校准）
- 1.2 完成前审计阶段（后移除 before_agent_start 注入）
- 1.3 三层触发（L0 捕获 / L1 签名 / L2 交付 fanout）、会话边界隔离
- 1.4 agent_end 阻塞产物审计（修复时序错位）
- 1.5 常驻审计者 resume 复用 + cwd 解析修复
- 1.6 决策链默认私有化（.pi/ 不污染 git）

---

## [1.6.0] - 2026-08-09

决策链默认私有化（不污染项目 git）+ cwd 相关配套。

### 新增：决策链默认写 .pi/ 私有目录

- **问题**：决策链默认写 `docs/decisions/chain.md`，会进项目的 git（用户没要求就多一个文件），违背"插件不越权"
- **修复**：默认写 `<项目根>/.pi/decision-auditor/chain.md`（私有，gitignore 覆盖）；设 `PI_PAIR_CHAIN_PUBLIC=1` 才写 `docs/decisions/chain.md`（团队可见，像 ADR）
- 审计任务模板、SKILL、README 同步更新路径说明

### 测试

- 验证 chainPath 默认/公开两种模式（18 单测全过）

## [1.5.0] - 2026-08-09

常量审计者（resume 复用）+ cwd 解析修复。

### 新增：常量审计者（resume 复用）

- **复用而非每次 spawn**：首次 spawn 审计者时记录 runId（state.json `auditorRunId`）；后续轮次 `resume` 同一个 run（带 session 历史，命中 provider 前缀缓存 → 缓存读取比 fresh 全量重发便宜）
- **缓存经济**：session 随轮膨胀可接受（前缀不变时命中缓存，成本递减）
- **提灯连续**：审计者 resume 后记得之前所有轮的目标/已审发现（不再每次从 convlog 重新考古）

### 修复：cwd 解析

- **问题**（审计者连续 3 次上报）：会话在 `C:\Users\Nuctori` 启动但项目在 `D:\goose`，插件用 `ctx.cwd` 导致 chain.md/state.json 写到错误位置
- **修复**：新增 `resolveProjectRoot`——从 cwd 向上最多 5 层找带仓库根标记（Cargo.toml/package.json/go.mod/.git 等）的目录，退化到 cwd；所有 handler 改用解析后的项目根
- 审计者路径检查提示仍保留（兜底）

### 测试

- 18 单测通过（新增 resolveProjectRoot 仓库根定位）

## [1.4.0] - 2026-08-09

产物交叉审计（agent_end 阻塞签名）——修复架构错位：审计时机从 turn_start（产物不存在）移到 agent_end（产物已存在）。

### 核心修复：产物必须被交叉审计

**问题**：v1.3 预启动审计在 turn_start spawn，但此刻本轮产物还不存在——审计者读的是旧 convlog/空 diff，签名是"形式签名"（只查行号），不保证本轮产物被审过。

**修复**：agent_end 阻塞交叉审计。

- **agent_end 时**：本轮有产物（convlog 新增 / 决策链新条目）→ spawn 审计者 → **await 等待完成**（Pi awaits handler，阻塞生效）
- **审计内容**：捕获本轮决策入链 → 审 git diff 产物忠实性（产物是否真的执行了决策）→ 独立核实 Context 事实
- **签名语义**：产物通过 → passed + signatureConvLine 推进；发现 blocker → blocked + signatureConvLine 不推进（待修复）
- **降低阻塞**：只审本轮增量（不审全链）+ 120s 超时上限（超时标记 blocked，不无限阻塞）+ fresh context 一次 spawn
- **spawn 失败**：产物未过审 → blocked 标记（不静默）

### 移除

- turn_start 预启动（审计时机错位的根源）
- before_agent_start 注入（不影响新一轮对话）

### 测试

- 17 单测通过

## [1.3.0] - 2026-08-09

subagent 交叉审计收敛方案：分层触发 + 会话边界隔离。

### 新增

- **L2 交付审查（fanout）**：用户明确要求交付（提交/发布/merge/交付/收工/上线/部署/推送）时，并行 spawn 3 个 fresh reviewer（正确性/目标一致性/安全健壮性）做产物级深度审查——这是多角度交叉审计的正确位置（交付前一次，不是持续跑）
- **会话边界隔离**：`session_start` 时 `resetForSessionStart` 清跨会话待签名状态（`signatureConvLine` 推进到当前 convlog 行数）——修复"新会话一开始就提醒审计"的跨会话污染；决策链审计进度（lastAuditedId/convExtractedLine）仍跨会话保留

### 架构（三层触发）

| 层 | 触发 | 审计者 | 成本 |
| --- | --- | --- | --- |
| L0 捕获 | convlog 增量累积达阈值（6 轮/8000 字符） | 1 个审计者（捕获+审决策链） | 低 |
| L1 签名 | 用户请求优先 + 未签名工作提醒 | 同上 + 自审计 | 低 |
| L2 交付审查 | 用户确认交付（提交/发布/merge） | 3 个 fresh reviewer 并行 fanout | 高（交付前 1 次） |

### 测试

- 17 单测通过（新增 resetForSessionStart 会话边界）

## [1.2.1] - 2026-08-08

交叉审计修复（基于独立 reviewer 的 3 角度审计发现）。

### 修复（按审计发现）

- **H1 锁生命周期错配**：`IN_FLIGHT_TTL_MS` 从 5min 提到 16min（> spawn 超时 15min），消除审计运行中锁过期导致的并发双审计（chain.md 重复编号 + state.json 互相覆盖）
- **H2 未插值占位符**：增量审计任务文本里 `${auditStatePath(cwd)}` 改为模板字符串（此前字面输出给审计者）
- **H3 字段名错误**：`pendingRounds` → `roundsSinceAudit`（agent 指令 + 任务文本同步）
- **H4 版本不同步**：package.json version 升到 1.2.0
- **M1 签名闭环**：新增 `decision_signoff` 工具（审计通过后签名，避免手写 state.json 整体覆盖）；注入文案改为引导用工具签名
- **M2 口径统一**：`convExtractedLine` 明确为对话行序号（## 👤/## 🤖 计数），任务文本同步
- **M3 RPC ready 探测**：ping 真正订阅 reply，收到即返回（不再固定吃满 5s）
- **M4 spawn 超时**：900s 超时传给 client（`rpc("spawn", params, 900_000)`）而非 params，消除 ACK>30s 的孤儿审计
- **M5 签名消毒**：`readAuditState` 对 signature 字段做类型消毒（坏值 → null，不再渲染 undefined）
- **M6 集成清理**：package.json 移除悬空的 `chains: ["./chains"]` 和误导性 `main`；README 补 v1.2 审计阶段章节 + 更新本地路径说明；prompts 补捕获步骤；SKILL "只读"→"只读代码"
- **M7 强制触发语义**：`accumulatePending` 加 `force` 参数，显式 `decision_add` 跳过 minInterval 节流直接触发
- **spawn 失败回写**：审计 spawn 失败时回写累积计数，避免已攒增量丢失

### 测试

- 16 单测通过（新增 force 跳过 minInterval、recordSignature 字段级写入、坏 signature 消毒）

## [1.2.0] - 2026-08-08

完成前审计阶段（pre-end signoff）：每轮工作开始前，若有未签名工作则注入审计阶段指令。

### 新增：完成前审计阶段（强制签名）

- **阶段注入**：`before_agent_start` 检测到上一轮有未签名工作（`needsSignoff`）时，注入 `pi-pair:audit-phase` 阶段提醒（`customType` 标记，非用户消息，**优先级低于用户请求**）
- **阶段内容**：自审计（agent 对照决策链/目标检查产物）→ 交叉审计（spawn decision-auditor 独立审查）→ 签名（更新 state.json `signature`）
- **优先级**：用户请求始终优先——审计是提醒不是门禁，来不及可在后续轮次补审，但尽量每次回复完成前签名

### 修复

- `convLogLineCount` 只统计对话行（此前头部注释行被误计）
- `needsSignoff` / `recordSignature` 状态机（签名后解除待签名）

### 测试

- 13 单测通过（新增 needsSignoff 状态机 + convLogLineCount）

## [1.1.0] - 2026-08-08

改名 **pi-pair**（原 pi-decision-auditor）+ 捕获机制重做（核心修复）。

### 核心修复：捕获不再依赖主 agent 自觉

**问题**：v1.0 的 `decision_add` 依赖主 agent 主动调用——它不调，链条在第一步就断（实际使用中零调用）。这违背了"主 agent 不可靠"的前提（不可靠的主 agent 也不会可靠地记录决策）。

**修复**：捕获责任转移给审计者。

- **审计者从 convlog 提取决策入链**：被唤起时第一步读对话日志增量（`convExtractedLine` 定位），识别主 agent 实际做的关键决策（方案取舍/架构改动/采纳的用户要求），按四元组 append-only 写入 `chain.md`——不靠主 agent 调用任何工具
- **增量累积唤起**（参数由 205 个历史会话数据校准）：每轮结束零成本记账 convlog 增量，达到阈值才 spawn 审计者，审计变批量、异步、跟随主任务节奏
  - `batchRounds: 6`（累积 5 决策的 p90=9 轮、p50=4 轮 → 6 轮折中）
  - `batchChars: 8000`（累积 3-5 决策字符 p50≈7.7k-9.6k）
  - `minIntervalRounds: 2`（防决策密集时频繁唤起，间距 p50=1）
  - `maxBatchRounds: 15`（决策稀疏兜底，间距 max=15）
  - 决策信号词即时触发**弃用**（54% 轮含信号词 = 开了等于每轮唤起）
- **手动 `decision_add` 仍即时触发**（主 agent 主动记录 = 强信号）
- 全部参数可用环境变量覆盖：`PI_PAIR_BATCH_ROUNDS` / `PI_PAIR_BATCH_CHARS` / `PI_PAIR_MIN_INTERVAL` / `PI_PAIR_MAX_BATCH`

### 实测（本地 + CI 免费模型）

- 主 agent 三步决策（Redis → 本地缓存 supersede → pytest），审计者**自动提取 3 条入链**（四元组完整、supersede 关系正确）并审出全部一致 ✓
- 11 个单测通过（含增量累积 4 条路径）
- CI 用 opencode CLI 免费模型（免 key、免登录）跑通 E2E

### 其他

- 包名/仓库名/agent runtime 名改为 `pi-pair` / `pi-pair.decision-auditor`

## [1.0.0] - 2026-08-08

首个正式发布。

### 核心能力

- **结对式自动唤起**：`decision_add` 落地即自动 spawn 审计者增量审计；每轮结束（`agent_settled`）补审未审决策；去重锁（state.json `inFlight` + 内存 TTL 双保险）防重复 spawn
- **目标推导**：扩展在 `message_end` 确定性写入 `convlog.md`（只记用户提示 + 助手回复，非全文 transcript）；审计者从对话日志独立推导任务目标——主 agent 自述不可信，以对话记录为准
- **漂移检测**：每条决策对照推导目标审漂移，识别目标外扩张
- **决策链审计（五问 + 两新增维度）**：推理有效性 / 完整性 / 链一致性 / 校准 / **正确性**（独立核实 Context 事实，抓虚构数字、过度设计、方案不可行）/ 产物忠实性（`--diff`）
- **独立核实**：审计者用 read/grep/find + 只读 bash（git log/diff、which、`python -c import`、npm ls）验证 Context 中每个可核实事实，不信任记录
- **查询式暴露**：证据不足 → `contact_supervisor(interview_request)` 按需问主会话；链矛盾 → `contact_supervisor(need_decision)` 请求裁决
- **链自愈**：发现矛盾 → 裁决 → 新条目 `Supersedes` 闭合，append-only 全程保持
- **工具**：`decision_add`（自动编号 D-00X、append-only、supersede 声明）、`decision_list`（读链）、`/pair-audit`（手动全量/定向/`--diff` 审计）
- **状态管理**：`lastAuditedId` 记录已审范围，跨会话持久，审计只跑增量

### 组件

- `extensions/decision-chain.ts`：工具 + 自动唤起 + convlog + pi-subagents RPC
- `lib/chain-store.ts`：chain.md / convlog / state.json 存储
- `agents/decision-auditor.md`：审计者协议（fresh context、只读 + state.json 收尾解锁）
- `skills/decision-chain/SKILL.md`：writer 侧纪律
- `prompts/pair-audit.md`：命令帮助

### 已知限制

- 本地路径安装（`pi install ./...`）时 pi-subagents 不自动发现包内 agent，需手动复制到 `~/.pi/agent/agents/`；npm/git 分发自动发现
- shell allowlist 可能拦截审计者的只读命令执行（exit 126），审计者以物理文件核查兜底
- `subagent:async-complete` 内存锁匹配不可靠，依赖 TTL + 文件锁兜底
