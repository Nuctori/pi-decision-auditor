# pi-pair

**Pair decision audit for pi coding agent** · 结对决策审计插件

[![npm](https://img.shields.io/npm/v/pi-pair)](https://www.npmjs.com/package/pi-pair)
[![CI](https://img.shields.io/github/actions/workflow/status/Nuctori/pi-pair/ci.yml?branch=master)](https://github.com/Nuctori/pi-pair/actions)
[![License](https://img.shields.io/npm/l/pi-pair)](LICENSE)

> [English](README.md) · [中文](README.zh-CN.md)

A persistent "pair auditor" (举灯人 / holder of the lamp) for every pi session. It holds the task goal across rounds, cross-audits each round's artifacts against a decision chain, and **blocks `agent_end` until the artifact passes the audit signature**.

![pi-pair](https://raw.githubusercontent.com/Nuctori/pi-pair/master/assets/pi-pair.png)

## Why

A single agent's thinking and output have **limited precision** — and two failure modes in particular:

- **Intention-execution instability**: the agent drifts from what you actually asked, or silently reinterprets the goal.
- **Reasoning instability**: it fabricates numbers, over-engineers, or confidently ships wrong logic.

A second agent ("pair") **cleans up after it**. But an independently-invoked audit has its own cost — time and tokens. pi-pair is built around one question:

> **Under tight time/cost control, can a pair auditor measurably raise output precision?**

Core premise: **the main agent is not reliable**. Decisions aren't recorded by its initiative (the auditor extracts them from the conversation log), and audit judgement doesn't trust its self-description (it trusts the conversation record and repository facts).

## Quick start

```bash
pi install npm:pi-pair
```

That's it. Start working normally — pi-pair hooks in automatically:

1. Each round, your work is **audited at `agent_end`** (blocking, ≤120s): goal derivation → adversarial 5-dimension attack → signature. Un-audited work can't be presented as "complete".
2. Your **decisions are captured** into `.pi/decision-auditor/chain.md` (append-only, auto-numbered) — extracted from the conversation log, not from your initiative.
3. On **delivery** ("submit / publish / merge / deploy"), 3 fresh reviewers fan out for a deep cross-check.

Requires **pi-subagents** (spawns/resumes the auditor). See [Installation](#installation).

## Table of contents

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
each session (session_start)
  └─ persistent auditor (runId persisted, resumed across rounds, hits prompt cache)

L0 — chain maintenance (non-blocking, batched, same auditor run)
  └─ every round: accumulateRound (convlog delta) — zero cost
  └─ threshold hit (6 rounds / 8000 chars / max 15): resume the SAME
     resident auditor run (one holder of the lamp, shared context)
      · capture incremental decisions into chain (append-only, auto-numbered)
      · adversarial chain review (5 elegance dimensions: atomicity / correctness /
        consistency / cohesion / completeness)
      · findings → chainFindings → injected to main agent next round (low priority)

L1 — artifact gate (agent_end, blocking, hard gate)
  └─ has artifacts? → resume/spawn auditor → audit this round's artifacts in window
     → await (120s cap)
      · adversarial 5-dimension attack on artifacts (guilty until proven innocent)
      · independently verify Context facts vs repository
      · in-window Q&A with main agent (contact_supervisor, 60s cap)
      · passed → end ✓
      · blocked → fix round (followUp, fix now) → re-audit → up to 3×
      · 3× still blocked → passed-with-warning release (end is end)
      · timeout (120s) → negotiated stop: steer auditor to sign current findings
        as blockers early (fix immediately) — hard kill only as fallback

L2 — delivery review (on "submit/publish/merge/deploy")
  └─ parallel fanout 3 fresh reviewers (correctness / goal-alignment / security-robustness)
```

**Hard gate**: `agent_end` blocks until the audit signature. A blocked artifact triggers an immediate fix round (follow-up message, max 3×), then releases with a warning — *end is end*. Un-audited work can never be presented as "complete".

**Layered cost control**: L1 audits every round's artifacts (the gate, cannot be skipped); L0 batches chain capture/review (6 rounds / 8000 chars) so chain maintenance doesn't run every round; L2 runs once per delivery. A high-signal **process log** (decision-intent summaries, ≤200 chars each, roll-trimmed) lets the auditor check artifacts against your reasoning trajectory instead of reverse-engineering it — CI bench confirms **zero measurable time cost** for this communication channel.

## Capabilities

| Capability | Description |
| --- | --- |
| **Artifacts must be cross-audited** | `agent_end` blocks until audit signature; blocked artifacts trigger an immediate fix round (max 3×), then release-with-warning |
| **Persistent pairing** | one resident auditor run per session — L0 (chain maintenance) and L1 (artifact gate) resume the same instance, sharing context; no second agent |
| **Not dependent on main agent** | decisions extracted from convlog, facts verified from repo, by an independent agent |
| **Decision chain** | default `.pi/decision-auditor/chain.md` (private, no git pollution); `PI_PAIR_CHAIN_PUBLIC=1` → `docs/decisions/chain.md` (team-visible) |
| **In-window communication** | auditor talks to the main agent only inside the agent_end window (contact_supervisor, 60s cap); negotiated stop on timeout — no out-of-window wake-ups |
| **Adversarial, calibrated** | 7-dimension attack (5 elegance + mechanism integrity + runtime-mode behavior), calibrated on real defects the same-model auditor missed |
| **Cost control** | batched L0 + once-per-delivery L2 + prompt-cache session reuse; CI bench regression guard on wall time |
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
| Extension | `extensions/decision-chain.ts` | hooks (session_start / agent_end / message_end / agent_settled) + tools (`decision_add` `decision_list` `decision_signoff`) + `/pair-audit` command |
| Storage | `lib/chain-store.ts` | decision chain read/write (append-only, auto-numbering, supersede) + audit state (`.pi/decision-auditor/state.json`) + convlog + process log + project-root resolution |
| Auditor | `agents/decision-auditor.md` | pairing audit protocol: goal derivation, capture, adversarial cross-audit, signoff |
| Discipline | `skills/decision-chain/SKILL.md` | writer-side rules: when to record decisions, audit phases, signoff semantics |

## Audit protocol

Each round the auditor:

1. **Derive goal**: read the conversation log (`convlog.md`), derive the task goal from user prompts — main agent's self-description is untrusted, user's words win
2. **Read the process log** (`process.md`): the main agent's intent trajectory (decision-signal summaries) — verify artifacts against it instead of reverse-engineering intent
3. **Audit**: adversarial attack in 7 dimensions — atomicity / correctness / consistency / cohesion / completeness + **mechanism integrity** (trigger chains have live call sites) + **runtime behavior vs claim** (blocking/async claims hold across print/TUI/RPC, or mode differences are flagged)
4. **Sign**: artifacts pass → `signature=passed`; findings → `signature=blocked` with actionable blockers (the main agent fixes them immediately)

Window rules: the auditor runs only inside the `agent_end` blocking window. It may `contact_supervisor` for clarification (60s cap — otherwise decide from evidence). On window timeout, the extension negotiates: the auditor signs current findings as blockers early, or confirms abort. Outside the window it never contacts the main agent.

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
| `PI_PAIR_BATCH_ROUNDS` | 6 | rounds threshold for L0 chain-maintenance trigger |
| `PI_PAIR_BATCH_CHARS` | 8000 | char threshold for L0 trigger |
| `PI_PAIR_MIN_INTERVAL` | 2 | min rounds between audits |
| `PI_PAIR_MAX_BATCH` | 15 | forced-audit fallback when decisions are sparse |
| `PI_PAIR_CHAIN_PUBLIC=1` | off | write chain to `docs/decisions/chain.md` (team-visible); default is `.pi/decision-auditor/chain.md` (private) |
| `PI_PAIR_PROCESS_LOG=0` | on | disable intent-signal process log (CI bench baseline) |
| `PI_PAIR_PROJECT_ROOT` | — | explicit single authoritative project root (cross-drive / complex setups); default auto-detects upward from cwd |
| `PI_DECISION_AUDITOR_INJECT=off` | on | disable chain-status injection (legacy, ignore) |

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
- **Persistent + cached**: auditor resumed across rounds (session history hits prompt cache) — continuous across rounds while controlling cost
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
