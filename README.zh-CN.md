# pi-pair

**pi coding agent 的结对决策审计插件** · Pair decision audit for pi

> [English](README.md) · [中文](README.zh-CN.md)

为每个 pi 会话提供常驻的"结对审计者"（举灯人）：持续持有任务目标，对照决策链交叉审计每一轮产物，**`agent_end` 必须通过审计签名才能结束**。

核心前提：**主 agent 不可靠**。所以决策记录不靠它自觉（审计者从对话日志独立提取），审计判断不信它自述（以对话记录与仓库事实为准）。

---

## 安装

```bash
pi install npm:pi-pair          # npm 分发
pi install ./pi-pair            # 本地开发
pi install git:github.com/Nuctori/pi-pair   # git 源
```

依赖：**pi-subagents**（负责 spawn / resume 审计者）。

> **本地路径安装注意**：pi-subagents 通常自动发现本地路径包内的 agent；若未自动发现 `agents/decision-auditor.md`，手动复制到 user scope：
>
> ```bash
> mkdir -p ~/.pi/agent/agents && cp agents/decision-auditor.md ~/.pi/agent/agents/
> ```

---

## 它做什么

```text
每个会话（session_start）
  └─ 常驻审计者（runId 持久化，跨轮 resume 复用，命中 prompt 缓存）

L0 — 链维护（非阻塞、批量）
  └─ 每轮：accumulateRound 记账（convlog 增量）——零成本
  └─ 达阈值（6 轮 / 8000 字符 / 最多 15 轮）：唤起审计者
      · 批量捕获增量决策入链（append-only、自动编号）
      · 对抗式链级复审（五维度：原子性 / 正确性 / 一致性 / 内聚 / 完备）
      · findings → chainFindings → 下轮注入主 agent（低优先级）

L1 — 产物门禁（agent_end，阻塞，硬门禁）
  └─ 有产物？→ resume/spawn 审计者 → 窗口内审本轮产物 → 等待（120s 上限）
      · 对抗式五维度进攻产物（guilty until proven innocent）
      · 独立核实 Context 事实 vs 仓库
      · 窗口内可问主 agent（contact_supervisor，60s 上限）
      · passed → end ✓
      · blocked → 当场修复轮（followUp）→ 再审计 → 最多 3 次
      · 3 次仍不过 → passed-with-warning 降级放行（end 就是 end）
      · 超时（120s）→ 协商中止：steer 通知审计者把已发现问题
        提前签成 blockers（立即修复）——强制 kill 只是兜底

L2 — 交付审查（用户说"提交/发布/merge/部署"等）
  └─ 并行 fanout 3 个 fresh reviewer（正确性 / 目标一致性 / 安全健壮性）深度审查
```

**硬门禁**：`agent_end` 阻塞等审计签名。blocked 的产物触发**当场修复轮**（follow-up 消息，最多 3 次），之后带警告放行——**end 就是 end**。未经审计的工作永远不会被当作"已完成"呈现。

**分层成本控制**：L1 每轮审产物（门禁，不可省）；L0 批量做链捕获/复审（6 轮 / 8000 字符），链维护不每轮跑；L2 每次交付跑一次。

---

## 为什么值得用

| 能力 | 说明 |
| --- | --- |
| **产物必须交叉审计** | `agent_end` 阻塞等签名；blocked 触发当场修复轮（最多 3 次），之后带警告放行 |
| **常驻结对** | 审计者 resume 复用，记得整个结对历史与目标 |
| **不靠主 agent 自觉** | 决策从对话日志提取、事实从仓库核实，独立第三方完成 |
| **决策链** | 默认 `.pi/decision-auditor/chain.md`（私有，不污染 git）；`PI_PAIR_CHAIN_PUBLIC=1` 写 `docs/decisions/chain.md`（团队可见） |
| **窗口内通信** | 审计者只在 agent_end 窗口内联系主 agent（contact_supervisor 60s 上限）；超时协商中止——无窗口外忽然唤起 |
| **成本可控** | 只审本轮增量 + 120s 上限；session 复用命中 prompt 缓存（比 fresh 全量便宜） |
| **cwd 自适应** | 从任何目录启动都能定位真实项目根（找 Cargo.toml/package.json/.git 等） |

---

## 组成

| 组件 | 路径 | 作用 |
| --- | --- | --- |
| 扩展 | `extensions/decision-chain.ts` | 钩子（session_start / agent_end / message_end）+ 工具（`decision_add` `decision_list` `decision_signoff`）+ `/pair-audit` 命令 |
| 存储 | `lib/chain-store.ts` | 决策链读写（append-only、自动编号、supersede）+ 审计状态（`.pi/decision-auditor/state.json`）+ 项目根定位 |
| 审计者 | `agents/decision-auditor.md` | 结对审计协议：目标推导、捕获、交叉审计、签名 |
| 纪律 | `skills/decision-chain/SKILL.md` | writer 侧规约：何时记录决策、审计阶段、签名语义 |

---

## 审计协议

审计者每轮执行：

1. **目标推导**：读对话日志（`convlog.md`）从用户提示推导任务目标——主 agent 自述不可信，以用户原话为准
2. **捕获**：提取主 agent 本轮实际做的关键决策，append 入决策链（不靠它自觉记录）
3. **审计**：对照目标审漂移 → 独立核实 Context 事实 vs 仓库 → 审推理链（有效性/完整性/一致性/校准）→ 对照 git diff 审产物忠实性
4. **签名**：产物通过 → `signature=passed`；发现问题 → `signature=blocked`（blockers 必须具体可操作，主 agent 当场修复）

窗口规约：审计者只在 agent_end 阻塞窗口内运行。窗口内可 `contact_supervisor` 澄清（60s 上限，否则按证据判定）。窗口超时 → 扩展协商：审计者把当前发现提前签成 blockers，或确认中止。窗口外**永不**联系主 agent。

---

## 工具

| 工具 | 作用 |
| --- | --- |
| `decision_add` | 主 agent 主动记录关键决策（自动编号 D-00X，append-only，可 supersede）——可选，审计者也会自动捕获 |
| `decision_list` | 读决策链 |
| `decision_signoff` | 审计通过后签名（优先用工具，避免手写 state.json） |
| `/pair-audit` | 手动触发全量/定向/`--diff` 审计 |

---

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_PAIR_BATCH_ROUNDS` | 6 | 增量累积触发审计的轮数阈值 |
| `PI_PAIR_BATCH_CHARS` | 8000 | 增量累积触发审计的字符阈值 |
| `PI_PAIR_MIN_INTERVAL` | 2 | 两次审计最小间隔（轮） |
| `PI_PAIR_MAX_BATCH` | 15 | 决策稀疏时强制审计兜底（轮） |
| `PI_DECISION_AUDITOR_INJECT=off` | 开 | 关闭链状态注入（历史遗留，默认可忽略） |
| `PI_PAIR_CHAIN_PUBLIC=1` | 关 | 决策链写 `docs/decisions/chain.md`（团队可见）；默认写 `.pi/decision-auditor/chain.md`（私有） |
| `PI_PAIR_PROCESS_LOG=0` | 开 | 关闭意图信号过程日志（CI 跑分基线）；默认记录高信号决策意图（≤200 字符/条，滚动截断） |

---

## 决策链格式

```markdown
## D-001: 采用 Redis 做读缓存 [Accepted]
- Context: QPS 峰值 2k；PG 读路径 60ms     ← 可验证事实（带数字/来源）
- Decision: 引入 Redis 缓存读路径
- Rationale: 缓存命中 <5ms；写路径失效策略   ← 由 Context 推出的推理
- Alternatives: Memcached（否决：功能少）    ← 被否方案 + 理由
- Confidence: high                          ← 校准：无数据不标 high
- Supersedes: D-00X                         ← 修订旧决策 = 新条目声明
```

---

## 设计要点

- **主 agent 不可靠**：决策记录由审计者提取，事实由审计者核实，审计判断不依赖主 agent 自述
- **常驻 + 缓存**：审计者 resume 复用（session 历史命中 prompt 缓存），保证跨轮连续又控制成本
- **append-only + 防篡改**：旧决策不修改，修订 = supersede
- **Context 是事实，Rationale 是推理**：审计者校验"推理是否由事实推出"，抓虚构数字、过度设计
- **end 就是 end**：审计门禁确定性退出——通过 / 修复循环（最多 3 次）/ 带警告放行。不死锁、无窗口外唤起

---

## License

MIT © Nuctori
