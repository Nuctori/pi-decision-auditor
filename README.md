# pi-decision-auditor

结对决策审计插件：捕获 AI 决策的推理链到 `docs/decisions/chain.md`，用只读审计者（`decision-auditor`）审**决策链本身**（推理有效性 / 完整性 / 链一致性 / 校准 / 产物忠实性），缺上下文时按需查询主会话——不是审代码，也不是 fork 整个会话。

## 安装

```bash
pi install ./pi-decision-auditor     # 本地
# 或 npm/git 分发:
pi install npm:pi-decision-auditor
```

要求：pi-subagents（用于 `/pair-audit` spawn 审计者）、avtc-pi-user-decisions（可选，用户决策链走它）。

> **本地路径安装注意**：pi-subagents 只扫描 `node_modules` 里的 package agents，本地路径安装（`./pi-decision-auditor`）不会自动发现 `agents/decision-auditor.md`。npm/git 分发自动发现；本地开发需手动把 agent 复制到 user scope：
>
> ```bash
> mkdir -p ~/.pi/agent/agents && cp agents/decision-auditor.md ~/.pi/agent/agents/
> ```

## 组成

| 组件 | 路径 | 作用 |
| --- | --- | --- |
| 扩展 | `extensions/decision-chain.ts` | `decision_add` / `decision_list` 工具、`/pair-audit` 命令、**自动唤起**（关键决策 + 里程碑）、链状态注入 |
| 存储 | `lib/chain-store.ts` | `docs/decisions/chain.md` 读写（append-only、自动编号、supersede 声明）+ 审计状态（`.pi/decision-auditor/state.json`） |
| 审计者 | `agents/decision-auditor.md` | 只读审计协议 + `contact_supervisor` 查询协议 |
| 纪律 | `skills/decision-chain/SKILL.md` | writer 侧规约：何时记录、格式、处理发现 |

## 使用

```text
# writer 侧：关键决策时记录（自动编号 D-00X）
decision_add(summary="采用 Redis 做读缓存", context="QPS 峰值 2k；PG 读路径 60ms", decision="引入 Redis 读缓存", rationale="命中 <5ms；写路径失效策略", alternatives="Memcached（否决：功能少）", confidence="high")

# 自动唤起（无需手动命令）：
# 1. 每次 decision_add 落地 → 自动 spawn 审计者增量审计（async，报告回来唤醒会话）
# 2. 每轮结束（agent_settled）→ 若有未审新决策，自动补审
# 审计者发现证据不足 → contact_supervisor 主动问主会话；发现链矛盾 → 请求裁决

# 手动全量/定向审计（可选）：
/pair-audit          # 全链
/pair-audit D-003    # 自 D-003 起增量
/pair-audit --diff   # 连带产物忠实性对照
```

## 设计要点

- **结对式自动唤起**：关键决策落地即审，里程碑收尾补审——审计者持续在场，无需手动触发
- **查询式暴露**：审计者凭决策链工作，真缺上下文时 `contact_supervisor(interview_request)` 问主会话，不是 fork 全部历史
- **上下文恒定小**：每轮输入 = 决策链增量 + 主会话按需回复，不随里程碑增长
- **去重锁**：审计进行中不重复 spawn（state.json inFlight + 内存 TTL 双保险），完成后自动释放
- **append-only**：旧决策不修改，修订 = 新条目 supersede 旧 id（防篡改）
- **Context 是事实，Rationale 是推理**：审计者校验"推理是否由事实推出"，防漂亮记录

## 配置

| 环境变量 | 作用 |
|---|---|
| `PI_DECISION_AUDITOR_INJECT=off` | 关闭链状态注入（默认开） |

## License

MIT
