---
name: decision-chain
description: 结对决策审计的纪律：何时用 decision_add 记录关键决策、决策链格式、里程碑用 /pair-audit 触发审计。主会话（writer）侧配合 decision-auditor 审计者的规约。
---

# 决策链纪律（Decision Chain Discipline）

你与一个只读的结对审计者（`decision-auditor`）共同工作。它审的是**决策推理链**（`docs/decisions/chain.md`），不是代码。你的职责是喂饱这条链，让审计可进行。

## 何时必须记录决策（用 `decision_add`）

出现以下任一情况即追加一条（不要攒到里程碑才记——审计者靠增量定位新决策）：

- 从**多个方案中做了取舍**（选了 A 弃 B，有实际否决理由）
- 决定了**架构/依赖/实现方式**（引入库、改数据流、选模式）
- 采纳了**用户的关键要求**（会影响后续方向的拍板）
- 修正/推翻**之前的一条决策**（用 `supersedes` 声明旧 id）

**不记**：命名、格式、单文件内实现细节、已有决策的自然延伸。

## 记录的推理链格式（`decision_add` 参数）

`Context` 必须只含**可验证事实**（带数字/来源），这是审计者校验推理有效性的锚点：

```
summary:      采用 Redis 做读缓存
context:      读多写少，QPS 峰值 2k；Postgres 读路径 60ms（压测记录）
decision:     引入 Redis 缓存读路径
rationale:    缓存命中时读路径 <5ms；写路径用失效策略保一致性
alternatives: Memcached（否决：功能少）；本地内存（否决：不可跨实例）
confidence:   high            # Context 有数据支撑才可 high
supersedes:   []              # 推翻旧决策时填旧 id
```

注意：`rationale` 必须能被 `context` 推出；写不出时先补 context 数据，别硬编理由。

## 里程碑触发审计

- 每完成一个**里程碑**（一组相关改动落地、测试绿）：`/pair-audit`
- 只看增量：`/pair-audit D-003`（自 D-003 起审计）
- 连带产物忠实性：`/pair-audit --diff`（审计者会对照 git diff）
- 审计是 async：启动后继续干活，报告回来再处理发现

## 处理审计发现

| 审计判定 | 你的动作 |
| --- | --- |
| 一致 ✓ | 继续 |
| 偏离 ✗ | 修复产物，或追加新决策 supersede 旧决策（决策改了，不是产物错） |
| 需裁决 ⚠ | 审计者会 `contact_supervisor` 问你；有真实上下文就补给它，需要用户拍板就转给用户 |

## 审计者问你了（contact_supervisor 进来时）

- `interview_request`：它要**真实上下文**（压测数字、依赖约束）——直接给事实，别给推理。
- `need_decision`：它发现**链矛盾**——裁决保留哪个，或转用户。

## 原则

1. **append-only**：旧决策绝不修改，修订 = 新条目 + supersede
2. **Context 是事实，Rationale 是推理**：两者混写 = 审计者会标记推理无效
3. **不为了好看写 Confidence**：无数据 = low/medium，审计者校准这一条
