# Changelog

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

## [Unreleased]

- 审计者加 bash 只读命令（已授权工具，受 shell allowlist 约束）
- 决策链 `D-000: 任务目标` 基线条目（可选，与 convlog 目标推导互补）
