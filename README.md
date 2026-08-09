# pi-pair

**Pair decision audit for pi coding agent** · 结对决策审计插件

> [English](README.md) · [中文](README.zh-CN.md)

A persistent "pair auditor" (举灯人 / holder of the lamp) for every pi session. It continuously holds the task goal, cross-audits each round's artifacts against the decision chain, and **blocks `agent_end` until the artifact passes the audit signature**.

Core premise: **the main agent is not reliable**. Decisions aren't recorded by its initiative (the auditor extracts them from the conversation log independently), and audit judgement doesn't trust its self-description (it trusts the conversation record and repository facts).

---

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

---

## What it does

```text
each session (session_start)
  └─ persistent auditor (runId persisted, resumed across rounds, hits prompt cache)

L0 — chain maintenance (non-blocking, batched)
  └─ every round: accumulateRound (convlog delta) — zero cost
  └─ threshold hit (6 rounds / 8000 chars / max 15): spawn auditor
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

**Hard gate**: `agent_end` blocks until the audit signature. A blocked artifact triggers an immediate fix round (follow-up message, max 3×), then releases with a warning — `end is end`. Un-audited work can never be presented as "complete".

**Layered cost control**: L1 audits every round's artifacts (the gate, cannot be skipped); L0 batches chain capture/review (6 rounds / 8000 chars) so chain maintenance doesn't run every round; L2 runs once per delivery.

---

## Why

| Capability | Description |
| --- | --- |
| **Artifacts must be cross-audited** | `agent_end` blocks until audit signature; blocked artifacts trigger an immediate fix round (max 3×), then release-with-warning |
| **Persistent pairing** | auditor resumed across rounds, remembers the whole pairing history & goal |
| **Not dependent on main agent** | decisions extracted from convlog, facts verified from repo, by an independent agent |
| **Decision chain** | default `.pi/decision-auditor/chain.md` (private, no git pollution); `PI_PAIR_CHAIN_PUBLIC=1` → `docs/decisions/chain.md` (team-visible) |
| **In-window communication** | auditor talks to the main agent only inside the agent_end window (contact_supervisor, 60s cap); negotiated stop on timeout — no out-of-window wake-ups |
| **Cost control** | audits only this round's increment + 120s cap; session reuse hits prompt cache (cheaper than fresh full-send) |
| **cwd adaptive** | finds the real project root from any start dir (Cargo.toml/package.json/.git etc) |

---

## Components

| Component | Path | Role |
| --- | --- | --- |
| Extension | `extensions/decision-chain.ts` | hooks (session_start / agent_end / message_end) + tools (`decision_add` `decision_list` `decision_signoff`) + `/pair-audit` command |
| Storage | `lib/chain-store.ts` | decision chain read/write (append-only, auto-numbering, supersede) + audit state (`.pi/decision-auditor/state.json`) + project-root resolution |
| Auditor | `agents/decision-auditor.md` | pairing audit protocol: goal derivation, capture, cross-audit, signoff |
| Discipline | `skills/decision-chain/SKILL.md` | writer-side rules: when to record decisions, audit phases, signoff semantics |

---

## Audit protocol

Each round the auditor:

1. **Derive goal**: read the conversation log (`convlog.md`), derive the task goal from user prompts — main agent's self-description is untrusted, user's words win
2. **Capture**: extract the main agent's actual key decisions this round, append to the decision chain (not its initiative)
3. **Audit**: drift vs goal → independently verify Context facts vs repo → audit the reasoning chain (validity/completeness/consistency/calibration) → audit artifact fidelity vs `git diff`
4. **Sign**: artifacts pass → `signature=passed`; findings → `signature=blocked` with actionable blockers (the main agent fixes them immediately)

Window rules: the auditor runs only inside the `agent_end` blocking window. It may `contact_supervisor` for clarification (60s cap — otherwise decide from evidence). On window timeout, the extension negotiates: the auditor signs current findings as blockers early, or confirms abort. Outside the window it never contacts the main agent.

---

## Tools

| Tool | Role |
| --- | --- |
| `decision_add` | main agent proactively records a key decision (auto-numbered D-00X, append-only, supersede) — optional; auditor also auto-captures |
| `decision_list` | read the decision chain |
| `decision_signoff` | sign after audit passes (use the tool, avoid hand-writing state.json) |
| `/pair-audit` | manual full/targeted/`--diff` audit |

---

## Environment

| Var | Default | Description |
| --- | --- | --- |
| `PI_PAIR_BATCH_ROUNDS` | 6 | rounds threshold for incremental-accumulation trigger |
| `PI_PAIR_BATCH_CHARS` | 8000 | char threshold for incremental-accumulation trigger |
| `PI_PAIR_MIN_INTERVAL` | 2 | min rounds between audits |
| `PI_PAIR_MAX_BATCH` | 15 | forced-audit fallback when decisions are sparse |
| `PI_DECISION_AUDITOR_INJECT=off` | on | disable chain-status injection (legacy, ignore) |
| `PI_PAIR_CHAIN_PUBLIC=1` | off | write chain to `docs/decisions/chain.md` (team-visible); default is `.pi/decision-auditor/chain.md` (private) |

---

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

---

## Design notes

- **Main agent unreliable**: decisions recorded by the auditor, facts verified by the auditor, judgement independent of main-agent self-description
- **Persistent + cached**: auditor resumed across rounds (session history hits prompt cache) — continuous across rounds while controlling cost
- **Append-only + tamper-proof**: old decisions never edited; revision = supersede
- **Context is fact, Rationale is reasoning**: the auditor checks "does the reasoning derive from the facts", catching fabricated numbers and over-engineering
- **End is end**: the audit gate exits deterministically — pass, fix-loop (max 3×), or release-with-warning. No deadlock, no out-of-window wake-ups

---

## License

MIT © Nuctori
