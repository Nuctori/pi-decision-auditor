# pi-pair

**Pair decision audit for pi coding agent** · 结对决策审计插件

[![npm](https://img.shields.io/npm/v/pi-pair)](https://www.npmjs.com/package/pi-pair)
[![CI](https://img.shields.io/github/actions/workflow/status/Nuctori/pi-pair/ci.yml?branch=master)](https://github.com/Nuctori/pi-pair/actions)
[![License](https://img.shields.io/npm/l/pi-pair)](LICENSE)

> [English](README.md) · [中文](README.zh-CN.md)

A fresh-spawn "pair auditor" (举灯人 / holder of the lamp) for every pi session. It captures decisions into a decision chain, cross-audits each round's artifacts against it, and **delivers any blocker immediately for fixing — the user sees the fixed result, not the audit process**. Delivery rounds gate on the audit signature; normal rounds run async without blocking.

![pi-pair](https://raw.githubusercontent.com/Nuctori/pi-pair/master/assets/pi-pair.png)

## Why

A single agent's thinking and output have **limited precision** — and two failure modes in particular:

- **Intention-execution instability**: the agent drifts from what you actually asked, or silently reinterprets the goal.
- **Reasoning instability**: it fabricates numbers, over-engineers, or confidently ships wrong logic.

A second agent ("pair") **cleans up after it**. But an independently-invoked audit has its own cost — time and tokens. pi-pair is built around one question:

> **Under tight time/cost control, can a pair auditor measurably raise output precision?**

Core premise: **the main agent is not reliable**. Decisions aren't recorded by its initiative (the auditor extracts them from the conversation log), and audit judgement doesn't trust its self-description (it trusts the conversation record and repository facts).

## Design philosophy

pi-pair makes deliberate trade-offs. Read these before deciding whether to adopt it:

- **The main agent is not reliable — build around that, not against it.** Decisions are extracted by the auditor (never by the main agent's initiative), facts are verified against the repository (never trusted from self-description), and audit judgement trusts the conversation record and repo state — not the main agent's summary of what it did.
- **Adversarial, not polite.** Artifacts are *guilty until proven innocent*: the auditor actively tries to break each dimension. A review that finds nothing to attack is a weak review, not a good one.
- **Simplicity is a feature, not a shortcut.** One audit layer, fresh-spawn runs, no resident process, no negotiation windows — each mechanism that survives earns its keep, each that fails is deleted rather than patched. The cost is fewer knobs; the payoff is a system you can reason about.
- **Value is observable, process is hidden.** The user sees the *fixed result* — blockers delivered and repaired — not the audit machinery (counts, timeouts, negotiations). Audit findings are injected user-visible; process noise never is.
- **Audit only what is real.** The auditor spawns only when real work may exist (git changes or new conversation), then AI-judges (step zero) whether to proceed — pure-chat rounds quick-exit with zero injection. Auditing empty rounds would be theater, and theater teaches the auditor to rubber-stamp.
- **Gate at delivery, not every round.** Normal rounds run async — the auditor works in the background and you're never blocked. The gate tightens only when it matters: submit / publish / merge / deploy.
- **Interim results over final ceremony.** The auditor writes findings continuously (`auditFindings`), so being killed mid-audit still delivers value. A finished signature is a formality, not the point.
- **Stop when done.** After signing, the auditor stops — no scope creep, no "just one more check". Open questions go to the next round, where the next agent has full context.

**What this means for you**: pi-pair raises output precision by (a) catching drift and fabricated reasoning before they ship, and (b) making the fixes cheap by surfacing them immediately. What it does *not* do: it does not guarantee correctness (same-model blind spots exist), chat-only rounds get a quick-exit verdict instead of an audit, and its value is proportional to how much real code/decision work your sessions produce.

## Quick start

```bash
pi install npm:pi-pair
```

That's it. Start working normally — pi-pair hooks in automatically:

1. Each round with real artifacts is **audited** (goal derivation → adversarial 5-dimension attack → signature): async in normal rounds (no blocking), sync gate on delivery rounds. Blockers are delivered immediately for fixing, re-audited until clean.
2. Your **decisions are captured** into `.pi/decision-auditor/chain.md` (append-only, auto-numbered) — extracted from the conversation log, not from your initiative.
3. On **delivery** ("submit / publish / merge / deploy"), 3 fresh reviewers fan out for a deep cross-check.

Requires **pi-subagents** (spawns the auditor). See [Installation](#installation).

## Table of contents

- [Why](#why)
- [Design philosophy](#design-philosophy)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Capabilities](#capabilities)
- [Installation](#installation)
- [Components](#components)
- [Audit protocol](#audit-protocol)
- [Tools](#tools)
- [Environment](#environment)
- [Decision chain format](#decision-chain-format)
- [Design notes](#design-notes)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [License](#license)

## How it works

```text
each agent_end (when real artifacts exist)
  └─ real artifacts? (git changes — .pi state excluded — or new conversation) → spawn auditor
     · auditor AI judges (step zero): pure chat / no decision / no artifacts → quick-exit, zero injection
  └─ normal rounds: async — agent_end does NOT block
     · fresh spawn auditor (context:"fork" — inherits this session's context)
     · one task = capture decisions into chain + audit artifacts + sign
     · interim results written to state.json as auditFindings — killed mid-audit still delivers value
  └─ delivery rounds (submit/publish/merge/deploy): agent_end awaits signature (300s cap)
      · adversarial 5-dimension attack on artifacts (guilty until proven innocent)
      · independently verify Context facts vs repository
      · continuous delivery: any blocker found → immediately notify main agent (fix → re-audit until clean)
      · passed → end ✓
      · 3× still blocked → passed-with-warning release (end is end)
      · timeout → release with warning + findings injected next round (no negotiate blackhole)

L2 — delivery review (on "submit/publish/merge/deploy")
  └─ only when real deliverables exist (gate: no git diff & no decisions → skip, no empty review)
  └─ parallel fanout 3 fresh reviewers (correctness / goal-alignment / security-robustness)
```

**Fresh-spawn pairing**: every audit spawns a fresh auditor run (`context:"fork"` — it inherits this session's conversation context, so it understands what "this session" is doing without a persistent run). The run ends when the audit ends — no resident process, no lifecycle bookkeeping, no residue. Normal rounds are async (no blocking, findings injected without user-visible noise); only delivery rounds await the signature. Any blocker found at any stage is delivered to the main agent immediately for fixing, re-audited until clean — the user sees the fixed result, not the audit process. Findings are value points: blockers / interim auditFindings are injected user-visible (`display:true`); only internal hints stay hidden.

**Layered cost control**: L1 (the single audit) runs per round with real artifacts; L2 runs once per delivery, gated on real deliverables. A high-signal **process log** (decision-intent summaries, ≤200 chars each, roll-trimmed) lets the auditor check artifacts against your reasoning trajectory instead of reverse-engineering it — CI bench confirms **zero measurable time cost** for this communication channel.

## Capabilities

| Capability | Description |
| --- | --- |
| **Artifacts must be cross-audited** | `agent_end` audits real artifacts; blocked artifacts trigger immediate delivery to the main agent (fix → re-audit), release-with-warning after 3× |
| **Single-layer pairing** | one audit per round — capture decisions into chain + audit artifacts + sign, in a single fresh-spawn run (context:"fork" inherits session context) |
| **Not dependent on main agent** | decisions extracted from convlog, facts verified from repo, by an independent agent |
| **Decision chain** | default `.pi/decision-auditor/chain.md` (private, no git pollution); `PI_PAIR_CHAIN_PUBLIC=1` → `docs/decisions/chain.md` (team-visible) |
| **Fresh-spawn lifecycle** | audit run ends when the audit ends — no resident process, no residue after session shutdown; pure-chat rounds spawn, quick-exit with zero injection |
| **Adversarial, calibrated** | 7-dimension attack (5 elegance + mechanism integrity + runtime-mode behavior), calibrated on real defects the same-model auditor missed |
| **Cost control** | real-artifact gating (no empty audits) + once-per-delivery L2 + process-log intent channel; CI bench regression guard on wall time |
| **cwd adaptive** | finds the real project root from any start dir (Cargo.toml/package.json/.git etc) |

## Installation

```bash
pi install npm:pi-pair          # npm dist
pi install ./pi-pair            # local dev
pi install git:github.com/Nuctori/pi-pair   # git source
```

Requires: **pi-subagents** (spawns / resumes the auditor).

> **Local-path note**: pi-subagents usually auto-discovers agents in local-path package roots. If `agents/decision-auditor.md` isn't found, copy it manually:
>
> ```bash
> mkdir -p ~/.pi/agent/agents && cp agents/decision-auditor.md ~/.pi/agent/agents/
> ```

## Components

| Component | Path | Role |
| --- | --- | --- |
| Extension | `extensions/decision-chain.ts` | hooks (session_start / agent_end / message_end) + tools (`decision_add` `decision_list` `decision_signoff`) + `/pair-audit` command |
| Storage | `lib/chain-store.ts` | decision chain read/write (append-only, auto-numbering, supersede) + audit state (`.pi/decision-auditor/state.json`) + convlog + process log + project-root resolution |
| Auditor | `agents/decision-auditor.md` | pairing audit protocol: goal derivation, capture, adversarial cross-audit, signoff |
| Discipline | `skills/decision-chain/SKILL.md` | writer-side rules: when to record decisions, audit phases, signoff semantics |

## Audit protocol

Each round the auditor:

1. **Derive goal**: read the conversation log (`convlog.md`), derive the task goal from user prompts — main agent's self-description is untrusted, user's words win
2. **Read the process log** (`process.md`): the main agent's intent trajectory (decision-signal summaries) — verify artifacts against it instead of reverse-engineering intent
3. **Audit**: adversarial attack in 7 dimensions — atomicity / correctness / consistency / cohesion / completeness + **mechanism integrity** (trigger chains have live call sites) + **runtime behavior vs claim** (blocking/async claims hold across print/TUI/RPC, or mode differences are flagged)
4. **Sign**: artifacts pass → `signature=passed`; findings → `signature=blocked` with actionable blockers (the main agent fixes them immediately)

Lifecycle rules: every audit is a fresh-spawn run (`context:"fork"` inheriting this session's context). Normal rounds run async after `agent_end` (the agent does not block); delivery rounds (a git HEAD change — an objective signal, no keyword matching for "done") await the signature (300s cap — on timeout, release with warning and inject findings next round; no negotiate blackhole). The auditor may `contact_supervisor` for clarification during its run (60s cap — otherwise decide from evidence). Interim findings are written continuously to `auditFindings`; the run stops immediately after signing (完成即停).

## Tools

| Tool | Role |
| --- | --- |
| `decision_add` | main agent proactively records a key decision (auto-numbered D-00X, append-only, supersede) — optional; auditor also auto-captures |
| `decision_list` | read the decision chain |
| `decision_signoff` | sign after audit passes (use the tool, avoid hand-writing state.json) |
| `/pair-audit` | manual full/targeted/`--diff` audit |

## Environment

| Var | Default | Description |
| --- | --- | --- |
| `PI_PAIR_CHAIN_PUBLIC=1` | off | write chain to `docs/decisions/chain.md` (team-visible); default is `.pi/decision-auditor/chain.md` (private) |
| `PI_PAIR_PROCESS_LOG=0` | on | disable intent-signal process log (CI bench baseline) |
| `PI_PAIR_PROJECT_ROOT` | — | explicit single authoritative project root (cross-drive / complex setups); default auto-detects upward from cwd |

## Decision chain format

```markdown
## D-001: 采用 Redis 做读缓存 [Accepted]
- Context: QPS 峰值 2k；PG 读路径 60ms     ← verifiable facts (with numbers/source)
- Decision: 引入 Redis 缓存读路径
- Rationale: 缓存命中 <5ms；写路径失效策略   ← reasoning derived from Context
- Alternatives: Memcached（否决：功能少）    ← rejected options + reason
- Confidence: high                          ← calibration: don't say high without data
- Supersedes: D-00X                         ← revising an old decision = new entry declares it
```

## Design notes

- **Main agent unreliable**: decisions recorded by the auditor, facts verified by the auditor, judgement independent of main-agent self-description
- **Fresh-spawn + context-forked**: every audit spawns a fresh auditor run (`context:"fork"`) — inherits this session's context, no resident process, no lifecycle bookkeeping
- **Append-only + tamper-proof**: old decisions never edited; revision = supersede
- **Context is fact, Rationale is reasoning**: the auditor checks "does the reasoning derive from the facts", catching fabricated numbers and over-engineering
- **End is end**: the audit gate exits deterministically — pass, fix-loop (max 3×), or release-with-warning. No deadlock, no out-of-window wake-ups
- **Information before frequency**: strengthen communication density (process log), not audit frequency — zero measurable cost, same trigger points

## Known limitations

- **`pi -p` (print mode)**: `agent_end` audit does not block — pi drops the extension handler at the spawn await; the auditor completes in the background and still signs, but the gate's blocking semantics are fully effective only in interactive mode (TUI / RPC).
- **Same-model auditor**: the auditor uses the main agent's model by default — the adversarial stance mitigates groupthink, but shared blind spots (both miss the same thing) are still possible. Cross-model auditing is on the roadmap.
- **CI E2E** uses a free no-key model (opencode CLI); audit verdicts are model-dependent by nature — the CI asserts mechanisms (capture / signature / lock), not verdict quality.
- **Multi-instance same-cwd**: the conversation log is keyed by cwd and shared by any pi instance running there. Since v1.0.14 every log line carries a per-instance `<!--run:<id>-->` tag and auditors only extract decisions from the tagged lines of the spawning session; untagged legacy lines count as context only. When another instance's real conversation is detected, automatic audits are skipped with a warning instead of silently mis-attributing decisions. Set `PI_PAIR_PROJECT_ROOT` to a single authoritative project root (or run from different cwds) to keep instances apart.

## Roadmap

- [ ] **Cross-model auditor** (`PI_PAIR_AUDITOR_MODEL`) — break same-model groupthink at the root
- [ ] **Benefit measurement** — audit records defect categories caught; recall/false-positive stats make "precision gain" quantitative
- [ ] **L1 tiering** — lightweight fast audit for routine rounds, deep audit for high-risk rounds

## License

MIT © Nuctori
