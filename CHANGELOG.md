# Changelog

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
