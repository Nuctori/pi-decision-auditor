# pair-audit

触发结对决策审计（async）。

## 用法

```text
/pair-audit [D-00X] [--diff] [消息]
```

| 参数 | 作用 |
| --- | --- |
| （无） | 审计决策链全部条目 |
| `D-00X` | 只审计该 id 起的新增决策 |
| `--diff` | 审计者额外对照 git diff，检查产物忠实性 |
| 消息 | 追加给审计者的补充要求 |

审计者是 `pi-pair.decision-auditor`（fresh context、bash 仅只读命令、写权限仅 append chain.md + 改 state.json）。启动后 async 运行，报告完成时唤醒主会话；审计中它会通过 `contact_supervisor` 按需查询主会话的真实上下文。审计协议：**捕获（convlog 提取决策入链）→ 目标推导（convlog）→ 漂移对照 → 独立核实（仓库事实）→ 推理链五问 → 正确性/过度设计 → 产物忠实性 → 签名（decision_signoff）**。
