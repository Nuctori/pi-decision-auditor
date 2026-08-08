# Changelog

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
