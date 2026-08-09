# pi-pair

**Pair decision audit for pi coding agent** · 结对决策审计插件

A persistent "pair auditor" (灯人/holder of the lamp) for every pi session. It continuously holds the task goal, cross-audits each round's artifacts against the decision chain, and **blocks `agent_end` until the artifact passes the audit signature**.

Core premise: **the main agent is not reliable**. Decisions aren't recorded by its initiative (the auditor extracts them from the conversation log independently), and audit judgement doesn't trust its self-description (it trusts the conversation record and repository facts).

---

## 安装 · Installation

```bash
pi install npm:pi-pair          # npm dist
pi install ./pi-pair            # local dev
pi install git:github.com/Nuctori/pi-pair   # git source
```

Requires: **pi-subagents** (spawns / resumes the auditor). Optional: avtc-pi-user-decisions.

> **Local-path note**: pi-subagents usually auto-discovers agents in settings' local-path package roots. If `agents/decision-auditor.md` isn't found, copy it manually:
>
> ```bash
> mkdir -p ~/.pi/agent/agents && cp agents/decision-auditor.md ~/.pi/agent/agents/
> ```

---

## 它做什么 · What it does

```text
each session (session_start)
  └─ persistent auditor (runId persisted, resumed across rounds, hits prompt cache)

each work round (agent_end, blocking signoff)
  └─ has artifacts? → resume/spawn auditor → audit real artifacts → await (120s cap)
      · capture round decisions into chain (not dependent on main agent)
      · audit git diff fidelity: did artifacts really execute the decisions?
      · independently verify Context facts vs repository
      · sign: passed=artifact approved; blocked=findings to fix

on delivery ("submit/publish/merge/deploy" etc)
  └─ parallel fanout 3 fresh reviewers (correctness / goal-alignment / security-robustness)
```

---

## 为什么值得用 · Why

| Capability | 说明 |
| --- | --- |
| **Artifacts must be cross-audited** | `agent_end` blocks until audit signature—un-audited work can't "finish" |
| **Persistent pairing** | auditor resumed across rounds, remembers the whole pairing history & goal |
| **Not dependent on main agent** | decisions extracted from convlog, facts verified from repo, by an independent agent |
| **Decision chain** | default `.pi/decision-auditor/chain.md` (private, no git pollution); `PI_PAIR_CHAIN_PUBLIC=1` → `docs/decisions/chain.md` (team-visible) |
| **Cost control** | audits only this round's increment + 120s cap; session reuse hits prompt cache (cheaper than fresh full-send) |
| **cwd adaptive** | finds the real project root from any start dir (Cargo.toml/package.json/.git etc) |

---

## 组成 · Components

| Component | Path | 作用 |
| --- | --- | --- |
| Extension | `extensions/decision-chain.ts` | hooks (session_start / agent_end / message_end) + tools (`decision_add` `decision_list` `decision_signoff`) + `/pair-audit` command |
| Storage | `lib/chain-store.ts` | decision chain read/write (append-only, auto-numbering, supersede) + audit state (`.pi/decision-auditor/state.json`) + project-root resolution |
| Auditor | `agents/decision-auditor.md` | pairing audit protocol: goal derivation, capture, cross-audit, signoff |
| Discipline | `skills/decision-chain/SKILL.md` | writer-side rules: when to record decisions, audit phases, signoff semantics |

---

## 审计协议 · Audit protocol

Each round the auditor:

1. **Derive goal**: read the conversation log (`convlog.md`), derive the task goal from user prompts—main agent's self-description is untrusted, user's words win
2. **Capture**: extract the main agent's actual key decisions this round, append to the decision chain (not its initiative)
3. **Audit**: drift vs goal → independently verify Context facts vs repo → audit the reasoning chain (validity/completeness/consistency/calibration) → audit artifact fidelity vs `git diff`
4. **Sign**: artifacts pass → `signature=passed`; findings → `signature=blocked` (to fix)

---

## 工具 · Tools

| Tool | 作用 |
| --- | --- |
| `decision_add` | main agent proactively records a key decision (auto-numbered D-00X, append-only, supersede) — optional; auditor also auto-captures |
| `decision_list` | read the decision chain |
| `decision_signoff` | sign after audit passes (use the tool, avoid hand-writing state.json) |
| `/pair-audit` | manual full/targeted/`--diff` audit |

---

## 环境变量 · Environment

| Var | Default | 说明 |
| --- | --- | --- |
| `PI_PAIR_BATCH_ROUNDS` | 6 | rounds threshold for incremental-accumulation trigger |
| `PI_PAIR_BATCH_CHARS` | 8000 | char threshold for incremental-accumulation trigger |
| `PI_PAIR_MIN_INTERVAL` | 2 | min rounds between audits |
| `PI_PAIR_MAX_BATCH` | 15 | forced-audit fallback when decisions are sparse |
| `PI_DECISION_AUDITOR_INJECT=off` | on | disable chain-status injection (legacy, ignore) |
| `PI_PAIR_CHAIN_PUBLIC=1` | off | write chain to `docs/decisions/chain.md` (team-visible); default is `.pi/decision-auditor/chain.md` (private) |

---

## 决策链格式 · Decision chain format

```markdown
## D-001: 采用 Redis 做读缓存 [Accepted]
- Context: QPS 峰值 2k；PG 读路径 60ms     ← verifiable facts (with numbers/source)
- Decision: 引入 Redis 缓存读路径
- Rationale: 缓存命中 <5ms；写路径失效策略   ← reasoning derived from Context
- Alternatives: Memcached（否决：功能少）    ← rejected options + reason
- Confidence: high                          ← calibration: don't say high without data
- Supersedes: D-00X                         ← revising an old decision = new entry declares it
```

---

## 设计要点 · Design notes

- **主 agent 不可靠 / main agent unreliable**: decisions recorded by the auditor, facts verified by the auditor, judgement independent of main-agent self-description
- **常驻 + 缓存 / persistent + cached**: auditor resumed across rounds (session history hits prompt cache) — continuous across rounds while controlling cost
- **append-only + 防篡改 / tamper-proof**: old decisions never edited; revision = supersede
- **Context 是事实，Rationale 是推理**: auditor checks "does the reasoning derive from the facts", catching fabricated numbers and over-engineering

---

## License

MIT © Nuctori
