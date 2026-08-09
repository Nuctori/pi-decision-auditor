# pi-pair

结对决策审计插件（pair audit）：**自动捕获** AI 决策推理链到 `docs/decisions/chain.md`，审计者随对话增量被自动唤起，审**决策链本身**（推理有效性/完整性/链一致性/校准/正确性/漂移）——不是审代码，也不是 fork 整个会话。核心前提：**主 agent 不可靠，决策记录不靠它自觉**。

## 安装

```bash
pi install ./pi-pair     # 本地
# 或 npm/git 分发:
pi install npm:pi-pair
```

要求：pi-subagents（用于 spawn 审计者）、avtc-pi-user-decisions（可选，用户决策链走它）。

> **本地路径安装注意**：pi-subagents 通常会自动扫描 settings 里的本地路径包根目录发现 agent；若你的版本未自动发现 `agents/decision-auditor.md`，手动复制到 user scope：
>
> ```bash
> mkdir -p ~/.pi/agent/agents && cp agents/decision-auditor.md ~/.pi/agent/agents/
> ```

## 组成

| 组件 | 路径 | 作用 |
| --- | --- | --- |
| 扩展 | `extensions/decision-chain.ts` | `decision_add` / `decision_list` 工具、`/pair-audit` 命令、**增量累积自动唤起**、convlog 记录、链状态注入 |
| 存储 | `lib/chain-store.ts` | `docs/decisions/chain.md` 读写（append-only、自动编号、supersede 声明）+ 审计状态/增量记账（`.pi/decision-auditor/state.json`） |
| 审计者 | `agents/decision-auditor.md` | 捕获 + 审计协议（提取决策入链、五问、`contact_supervisor` 查询） |
| 纪律 | `skills/decision-chain/SKILL.md` | writer 侧规约：何时记录、格式、处理发现 |

## 使用

```text
# writer 侧（可选）：关键决策时主动记录（自动编号 D-00X）
decision_add(summary="采用 Redis 做读缓存", context="QPS 峰值 2k；PG 读路径 60ms", decision="引入 Redis 读缓存", rationale="命中 <5ms；写路径失效策略", alternatives="Memcached（否决：功能少）", confidence="high")

# 自动捕获（核心机制，无需主 agent 做任何事）：
# 1. 每轮结束（agent_settled）零成本记账 convlog 增量
# 2. 增量累积到阈值（默认 6 轮 / 8000 字符）→ 自动 spawn 审计者
# 3. 审计者先【捕获】：从对话日志提取主 agent 实际做的决策，append 入 chain.md
# 4. 审计者再【审计】：目标推导 → 漂移对照 → 独立核实 → 推理五问
# 5. 证据不足 → contact_supervisor 问主会话；链矛盾 → 请求裁决

# 完成前审计阶段（自动，无需手动）:
# 下一轮开始时若上一轮有未签名工作 → 注入 pi-pair:audit-phase 提醒
# 处理顺序: 用户请求优先 → 自审计 → 交叉审计 → decision_signoff 签名
```

## 完成前审计阶段（v1.2）

每轮工作开始前，若检测到上一轮有未签名工作（`needsSignoff`），系统注入 `pi-pair:audit-phase` 阶段提醒（`customType` 标记，非用户消息）：

- **优先级**：用户请求始终优先——审计是提醒不是门禁，来不及可在后续轮次补审
- **阶段内容**：① 自审计（agent 对照决策链/目标检查产物）② 交叉审计（spawn decision-auditor 独立审查）③ 签名（`decision_signoff` 工具）
- **签名语义**：`signature.status` = `passed` / `blocked`（带 blockers）；签名后解除待签名状态
- **工具**：`decision_signoff`（签名用，避免手写 state.json）、`decision_add`（补录决策）

## 设计要点

- **捕获不靠主 agent**：审计者从对话日志提取决策入链（`convExtractedLine` 去重）——主 agent 不可靠，记录由独立第三方完成
- **增量累积唤起**：每轮记账 convlog 增量，达到阈值才 spawn，审计批量、异步、跟随主任务节奏（参数经 205 个历史会话校准）
- **查询式暴露**：审计者凭决策链工作，真缺上下文时 `contact_supervisor(interview_request)` 问主会话，不是 fork 全部历史
- **上下文恒定小**：每轮输入 = 决策链增量 + 主会话按需回复，不随里程碑增长
- **去重锁**：审计进行中不重复 spawn（state.json inFlight + 内存 TTL 双保险），完成后自动释放
- **append-only**：旧决策不修改，修订 = 新条目 supersede 旧 id（防篡改）
- **Context 是事实，Rationale 是推理**：审计者校验"推理是否由事实推出"，防漂亮记录

## 配置

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_PAIR_BATCH_ROUNDS` | 6 | 累积多少轮对话触发审计 |
| `PI_PAIR_BATCH_CHARS` | 8000 | 或累积多少 convlog 字符触发审计 |
| `PI_PAIR_MIN_INTERVAL` | 2 | 两次审计最小间隔（轮） |
| `PI_PAIR_MAX_BATCH` | 15 | 决策稀疏时强制审计兜底（轮） |
| `PI_DECISION_AUDITOR_INJECT=off` | 开 | 关闭链状态注入与审计阶段提醒 |

## License

MIT
