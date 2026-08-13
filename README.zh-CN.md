# pi-pair

**pi coding agent 的结对决策审计插件** · Pair decision audit for pi

[![npm](https://img.shields.io/npm/v/pi-pair)](https://www.npmjs.com/package/pi-pair)
[![CI](https://img.shields.io/github/actions/workflow/status/Nuctori/pi-pair/ci.yml?branch=master)](https://github.com/Nuctori/pi-pair/actions)
[![License](https://img.shields.io/npm/l/pi-pair)](LICENSE)

> [English](README.md) · [中文](README.zh-CN.md)

为每个 pi 会话提供"结对审计者"（举灯人）：把关键决策记入决策链，对照它交叉审计每一轮产物，**任何 blocker 立即交付主 agent 修复——用户看到的是修好的结果，不是审计的流程**。交付轮以审计签名为门禁；常规轮异步不阻塞。

![pi-pair](https://raw.githubusercontent.com/Nuctori/pi-pair/master/assets/pi-pair.png)

## 为什么需要

单个 agent 的思考与产出**精度有限**，主要有两类失败模式：

- **意图执行不稳定**：偏离你真正的要求，或悄悄重新解释目标。
- **思考不稳定**：虚构数字、过度设计、自信地交付错误逻辑。

第二个 agent（"pair"）来**擦屁股**。但独立唤起的审计本身有时间/token 成本。pi-pair 围绕一个问题构建：

> **在严格控制时间/成本的前提下，结对审计能否可衡量地提升产出精度？**

核心前提：**主 agent 不可靠**。决策记录不靠它自觉（审计者从对话日志独立提取），审计判断不信它自述（以对话记录与仓库事实为准）。

## 设计哲学

pi-pair 做了刻意的取舍。决定是否采用前，先读这些：

- **主 agent 不可靠——围绕它设计，而非对抗它**。决策由审计者提取（绝不靠主 agent 自觉）、事实对照仓库核实（绝不信自述）、审计判断依据对话记录与仓库状态——而非主 agent 对自己做了什么的自述。
- **对抗而非客气**。产物*默认有缺陷*（guilty until proven innocent）：审计者主动尝试推翻每个维度。一个什么都攻击不动的审查是弱审查，不是好审查。
- **简单是特性，不是偷懒**。单层审计、fresh spawn、无常驻进程、无协商窗口——每个存活下来的机制都要证明自己，失败的机制被删除而非打补丁。代价是旋钮更少；回报是一个你能推演的系统。
- **价值可观察，流程隐藏**。用户看到*修好的结果*——blocker 被交付并修复——而非审计机制（计数、超时、协商）。审计发现用户可见；流程噪音永不呈现。
- **只审真实的**。审计者只在真实工作存在时 spawn：git 产物（未提交改动/新提交）必审；仅对话增量时需本轮调用了 `decision_add`（客观决策信号）才 spawn。纯咨询轮**永不 spawn**——没有后台任务、没有完成通知噪音（零噪音承诺从零注入升级为零 spawn）。没用 decision_add 的 plan 决策不丢：convlog 游标停留，下一个产物轮的审计者会连同自己的窗口一并提取。审空轮次是走形式，走形式会教会审计者盖章放行。
- **交付把关，而非每轮把关**。常规轮异步——审计者在后台工作，你永不被阻塞。门禁只在交付时刻收紧：**git 提交产生时**（客观信号，不用词表/模式匹配判断「完工」——语义判断不可靠，问句天然免疫）。
- **中间结果优先于收尾仪式**。审计者持续写发现（`auditFindings`），中途被杀也交付价值。完成的签名是形式，不是重点。
- **完成即停**。签名后审计者立即停止——不扩大范围、不再"多查一项"。遗留问题留给下一轮，那里的 agent 有完整上下文。

**对你的意义**：pi-pair 通过 (a) 在漂移与虚构推理出货前抓住它们、(b) 立即浮出问题让修复变便宜，来提升产出精度。它**不**做的事：不保证正确性（同模型盲区存在）、不审纯对话会话、价值与你会话产生的真实代码/决策量成正比。

## 快速开始

```bash
pi install npm:pi-pair
```

完成。正常开工即可——pi-pair 自动接管：

1. 有真实产物的每轮被**审计**（目标推导 → 对抗式五维度进攻 → 签名）：常规轮异步不阻塞，交付轮同步门禁。发现缺口立即交付修复、再审直到干净。
2. 你的**决策自动入链** `.pi/decision-auditor/chain.md`（append-only、自动编号）——从对话日志提取，不靠你自觉记录。
3. **交付时**（"提交/发布/merge/部署"）3 个 fresh reviewer 并行深度交叉审查。

依赖 **pi-subagents**（spawn 审计者）。见[安装](#安装)。

## 目录

- [为什么需要](#为什么需要)
- [设计哲学](#设计哲学)
- [快速开始](#快速开始)
- [工作原理](#工作原理)
- [安装](#安装)
- [组成](#组成)
- [审计协议](#审计协议)
- [工具](#工具)
- [环境变量](#环境变量)
- [决策链格式](#决策链格式)
- [设计要点](#设计要点)
- [已知限制](#已知限制)
- [Roadmap](#roadmap)
- [License](#license)

## 工作原理

```text
每次 agent_end（有真实工作时）
  └─ 真实工作？git 产物（未提交改动/新提交，排除 .pi 状态）→ 必 spawn；
     仅对话增量 → 本轮调用了 decision_add 才 spawn（纯咨询：永不 spawn——零噪音）
  └─ 常规轮：异步——agent_end 不阻塞
     · fresh spawn 审计者（context:"fork" 继承本会话上下文）
     · 一次任务 = 捕获决策入链 + 审产物 + 签名
     · 中间结果边审边写 state.json（auditFindings）——中途被杀也交付价值
     · 没用 decision_add 的 plan 决策由下一个产物轮的审计者顺带提取（游标停留）
  └─ 交付轮（提交/发布/merge/部署）：agent_end 等签名（300s 上限）
      · 对抗式五维度进攻产物（guilty until proven innocent）
      · 独立核实 Context 事实 vs 仓库
      · 持续交付：发现任何 blocker → 立即通知主 agent（修复 → 再审，直到干净）
      · passed → end ✓
      · 3 次仍不过 → passed-with-warning 降级放行（end 就是 end）
      · 超时 → 降级放行 + findings 下轮注入（无 600s 协商黑洞）

L2 — 交付审查（用户说"提交/发布/merge/部署"等）
  └─ 仅当有真实交付物时（门禁：无 git diff 且无决策 → 跳过，不空审）
  └─ 并行 fanout 3 个 fresh reviewer（正确性 / 目标一致性 / 安全健壮性）深度审查
```

**fresh spawn 结对**：每次审计新起一个审计者 run（`context:"fork"`——继承本会话的对话上下文，理解"本会话"在做什么，无需常驻 run）。审计结束 run 即结束——无常驻进程、无生命周期登记、无残留。常规轮异步（不阻塞，findings 注入不打扰用户）；仅交付轮等签名。任何阶段发现任何 blocker 立即交付主 agent 处理、再审直到干净——用户看到的是修好的结果，不是审计的流程。**价值点可观察**：blockers / 中间态 auditFindings 以 `display:true` 注入（用户感知价值）；仅内部提示保持隐藏。

**分层成本控制**：单层审计（L1）在有真实产物的轮次运行；L2 每次交付跑一次、且以真实交付物为门禁。高信号**过程日志**（决策意图摘要，≤200 字符/条，滚动截断）让审计者对照你的推理轨迹审产物而非反推——CI 跑分确认**该通信通道零可测时间成本**。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| **产物必须交叉审计** | `agent_end` 审计真实产物；blocked 立即交付主 agent（修复 → 再审），3 次后带警告放行 |
| **单层结对** | 每轮一次审计——捕获决策入链 + 审产物 + 签名，由单个 fresh spawn run 完成（context:"fork" 继承会话上下文） |
| **不靠主 agent 自觉** | 决策从对话日志提取、事实从仓库核实，独立第三方完成 |
| **决策链** | 默认 `.pi/decision-auditor/chain.md`（私有，不污染 git）；`PI_PAIR_CHAIN_PUBLIC=1` 写 `docs/decisions/chain.md`（团队可见） |
| **fresh spawn 生命周期** | 审计结束 run 即结束——无常驻进程、无残留；纯咨询轮**永不 spawn**（零噪音：无后台任务、无完成通知） |
| **对抗且经校准** | 七维度进攻（五优雅维度 + 机制完整性 + 运行时行为），用同模型审计漏掉过的真实缺陷校准 |
| **成本可控** | 真实产物门禁（无空审）+ L2 一次交付一次 + 过程日志意图通道；CI 跑分护栏监控墙钟时间 |
| **cwd 自适应** | 从任何目录启动都能定位真实项目根（找 Cargo.toml/package.json/.git 等） |

## 安装

```bash
pi install npm:pi-pair          # npm 分发
pi install ./pi-pair            # 本地开发
pi install git:github.com/Nuctori/pi-pair   # git 源
```

依赖：**pi-subagents**（负责 spawn 审计者）。

> **本地路径安装注意**：pi-subagents 通常自动发现本地路径包内的 agent；若未自动发现 `agents/decision-auditor.md`，手动复制到 user scope：
>
> ```bash
> mkdir -p ~/.pi/agent/agents && cp agents/decision-auditor.md ~/.pi/agent/agents/
> ```

## 组成

| 组件 | 路径 | 作用 |
| --- | --- | --- |
| 扩展 | `extensions/decision-chain.ts` | 钩子（session_start / agent_end / message_end）+ 工具（`decision_add` `decision_list` `decision_signoff`）+ `/pair-audit` 命令 |
| 存储 | `lib/chain-store.ts` | 决策链读写（append-only、自动编号、supersede）+ 审计状态（`.pi/decision-auditor/state.json`）+ convlog + 过程日志 + 项目根定位 |
| 审计者 | `agents/decision-auditor.md` | 结对审计协议：目标推导、捕获、对抗式交叉审计、签名 |
| 纪律 | `skills/decision-chain/SKILL.md` | writer 侧规约：何时记录决策、审计阶段、签名语义 |

## 审计协议

审计者每轮执行：

1. **目标推导**：读对话日志（`convlog.md`）从用户提示推导任务目标——主 agent 自述不可信，以用户原话为准
2. **读过程日志**（`process.md`）：主 agent 的意图轨迹（决策信号摘要）——对照它审产物，而非反推意图
3. **审计**：对抗式七维度进攻——原子性 / 正确性 / 一致性 / 内聚 / 完备 + **机制完整性**（触发链每环有实际调用点）+ **运行时行为 vs 声明**（阻塞/异步声明在 print/TUI/RPC 各模式成立，或标注模式差异）
4. **签名**：产物通过 → `signature=passed`；发现问题 → `signature=blocked`（blockers 具体可操作，主 agent 当场修复）

生命周期规约：每次审计都是 fresh spawn run（`context:"fork"` 继承本会话上下文）。常规轮在 agent_end 后异步运行（主 agent 不阻塞）；交付轮（提交/发布/merge/部署）等签名（300s 上限——超时降级放行 + findings 下轮注入，无协商黑洞）。审计者运行期间可 `contact_supervisor` 澄清（60s 上限，否则按证据判定）。中间发现持续写入 `auditFindings`；签名后立即停止（完成即停）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `decision_add` | 主 agent 主动记录关键决策（自动编号 D-00X，append-only，可 supersede）——可选，审计者也会自动捕获 |
| `decision_list` | 读决策链 |
| `decision_signoff` | 审计通过后签名（优先用工具，避免手写 state.json） |
| `/pair-audit` | 手动触发全量/定向/`--diff` 审计 |

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PI_PAIR_CHAIN_PUBLIC=1` | 关 | 决策链写 `docs/decisions/chain.md`（团队可见）；默认写 `.pi/decision-auditor/chain.md`（私有） |
| `PI_PAIR_PROCESS_LOG=0` | 开 | 关闭意图信号过程日志（CI 跑分基线） |
| `PI_PAIR_PROJECT_ROOT` | — | 显式指定单一权威项目根（跨盘符/复杂场景）；默认从 cwd 向上自动探测 |
| `PI_PAIR_LANG=en` | 中文 | TUI 审计状态语言：`en` 切英文，默认中文（与现有 UI 文案一致） |

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

## 设计要点

- **主 agent 不可靠**：决策记录由审计者提取，事实由审计者核实，审计判断不依赖主 agent 自述
- **fresh spawn + context fork**：每次审计新起 run（`context:"fork"`）——继承本会话上下文，无常驻进程、无生命周期登记
- **append-only + 防篡改**：旧决策不修改，修订 = supersede
- **Context 是事实，Rationale 是推理**：审计者校验"推理是否由事实推出"，抓虚构数字、过度设计
- **end 就是 end**：审计门禁确定性退出——通过 / 修复循环（最多 3 次）/ 带警告放行。不死锁、无窗口外唤起
- **信息前置，频率不变**：强化通信密度（过程日志）而非提高审计频率——零可测成本，触发点不变

## 已知限制

- **`pi -p`（print 模式）**：`agent_end` 审计不阻塞——pi 在 spawn await 处丢弃扩展 handler；审计者在后台完成并仍签名，但门禁的"阻塞"语义只在交互模式（TUI / RPC）完整生效。
- **同模型审计者**：默认与主 agent 同模型——对抗立场缓解同构偏见，但共同盲区仍可能（双方都漏同一个问题）。跨模型审计在 roadmap。
- **CI E2E** 用免费免 key 模型（opencode CLI）；审计结论天然依赖模型——CI 断言机制（捕获/签名/锁），不断言结论质量。

## Roadmap

- [ ] **跨模型审计者**（`PI_PAIR_AUDITOR_MODEL`）——从根上破除同模型同构偏见
- [ ] **收益测量**——审计记录抓到的问题类别；召回率/误报率统计让"精度提升"可量化
- [ ] **L1 分级**——常规轮轻量快速审，高风险轮深度审

## License

MIT © Nuctori
