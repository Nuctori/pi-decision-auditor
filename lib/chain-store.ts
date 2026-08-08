// SPDX-License-Identifier: MIT
// 决策链存储：docs/decisions/chain.md（append-only，自动编号，supersede 声明）
// 纯 Node 实现，无第三方依赖。

import * as fs from "node:fs";
import * as path from "node:path";

export interface DecisionFields {
	summary: string;
	context: string;
	decision: string;
	rationale: string;
	alternatives?: string;
	confidence?: "high" | "medium" | "low";
	supersedes?: string[];
}

export interface DecisionEntry extends DecisionFields {
	id: string;
	status: string;
	date: string;
}

const ENTRY_RE = /^## (D-\d+): (.+?) \[(.+)\]\r?\n((?:^- .*(?:\r?\n|$))*)/gm;
const FIELD_RE = /^- (\w+): (.*)$/gm;
const HEADER = `# Decision Chain

<!--
  结对决策审计的决策链。只追加，不修改旧条目。
  新决策通过 decision_add 工具追加（自动编号），审计者只读本文件。
  修订旧决策 = 新条目声明 Supersedes: D-00X。
-->
`;

export function chainPath(cwd: string): string {
	return path.join(cwd, "docs", "decisions", "chain.md");
}

export function ensureChain(cwd: string): string {
	const file = chainPath(cwd);
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, HEADER, "utf-8");
	}
	return file;
}

/** 读文件原文；缺失视为空链。 */
export function readRaw(cwd: string): string {
	const file = chainPath(cwd);
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return HEADER;
	}
}

/** 解析链中所有条目（文件序 = 决策序）。 */
export function parseChain(raw: string): DecisionEntry[] {
	const out: DecisionEntry[] = [];
	ENTRY_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ENTRY_RE.exec(raw)) !== null) {
		const [, id, summary, status, body] = m;
		const fields: Record<string, string> = {};
		FIELD_RE.lastIndex = 0;
		let f: RegExpExecArray | null;
		while ((f = FIELD_RE.exec(body)) !== null) {
			fields[f[1]] = f[2];
		}
		out.push({
			id,
			summary,
			status,
			context: fields["Context"] ?? "",
			decision: fields["Decision"] ?? "",
			rationale: fields["Rationale"] ?? "",
			alternatives: fields["Alternatives"] ?? undefined,
			confidence:
				(fields["Confidence"] as DecisionEntry["confidence"]) ?? undefined,
			supersedes: fields["Supersedes"]
				? fields["Supersedes"]
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined,
			date: fields["Date"] ?? "",
		});
	}
	return out;
}

/** 下一个编号：max(D-NNN)+1；空链从 D-001 起。 */
export function nextId(entries: DecisionEntry[]): string {
	let max = 0;
	for (const e of entries) {
		const n = Number(e.id.slice(2));
		if (Number.isFinite(n) && n > max) max = n;
	}
	return `D-${String(max + 1).padStart(3, "0")}`;
}

/** 追加一条决策（append-only；返回新条目）。 */
export function appendDecision(
	cwd: string,
	fields: DecisionFields,
	now: Date = new Date(),
): DecisionEntry {
	const file = ensureChain(cwd);
	const raw = readRaw(cwd);
	const entries = parseChain(raw);
	const id = nextId(entries);
	const supersedes =
		fields.supersedes && fields.supersedes.length > 0
			? fields.supersedes
			: undefined;
	const entry: DecisionEntry = {
		...fields,
		id,
		status: "Accepted",
		date: now.toISOString(),
		supersedes,
	};
	const lines = [
		`## ${id}: ${entry.summary} [${entry.status}]`,
		`- Context: ${entry.context}`,
		`- Decision: ${entry.decision}`,
		`- Rationale: ${entry.rationale}`,
	];
	if (entry.alternatives) lines.push(`- Alternatives: ${entry.alternatives}`);
	if (entry.confidence) lines.push(`- Confidence: ${entry.confidence}`);
	if (entry.supersedes && entry.supersedes.length > 0)
		lines.push(`- Supersedes: ${entry.supersedes.join(", ")}`);
	lines.push(`- Date: ${entry.date}`);
	lines.push("");
	fs.appendFileSync(file, `\n${lines.join("\n")}`, "utf-8");
	return entry;
}

/** 列出条目，可选 onlyFromId（含该 id 起的新条目）。 */
export function listEntries(cwd: string, onlyFromId?: string): DecisionEntry[] {
	const entries = parseChain(readRaw(cwd));
	if (!onlyFromId) return entries;
	const idx = entries.findIndex((e) => e.id === onlyFromId);
	return idx < 0 ? [] : entries.slice(idx);
}

/** 渲染一条决策为紧凑文本（供审计者/列表读）。 */
export function renderEntry(e: DecisionEntry): string {
	const lines = [
		`## ${e.id}: ${e.summary} [${e.status}]`,
		`- Context: ${e.context}`,
		`- Decision: ${e.decision}`,
		`- Rationale: ${e.rationale}`,
	];
	if (e.alternatives) lines.push(`- Alternatives: ${e.alternatives}`);
	if (e.confidence) lines.push(`- Confidence: ${e.confidence}`);
	if (e.supersedes && e.supersedes.length > 0)
		lines.push(`- Supersedes: ${e.supersedes.join(", ")}`);
	lines.push(`- Date: ${e.date}`);
	return lines.join("\n");
}

// ---- 审计状态（上次审计到哪、是否有进行中的审计）----
// 存 <cwd>/.pi/decision-auditor/state.json，跨会话持久。

export interface AuditSignature {
	/** 签名状态：passed=审计通过；blocked=发现问题；timeout=超时未完成。 */
	status: "passed" | "blocked" | "timeout";
	/** 签名时间（epoch ms）。 */
	at: number;
	/** blocker 摘要（blocked 时）。 */
	blockers?: string[];
	/** 本轮审计的 runId。 */
	runId?: string;
}

export interface AuditState {
	/** 上次审计覆盖到的最后一条 id（含）。null = 从未审计。 */
	lastAuditedId: string | null;
	/** 是否有进行中的审计（防重入）。 */
	inFlight: boolean;
	/** convlog 已提取到的行号（审计者提取决策后推进）。0 = 从头。 */
	convExtractedLine: number;
	/** 距上次审计的轮数（minInterval 判断用）。 */
	roundsSinceAudit: number;
	/** 待审增量记账：已累积的 convlog 字符数。 */
	pendingChars: number;
	/** 上次审计时间（epoch ms）。 */
	lastAuditAt: number;
	/** 本轮签名（agent_end 强制签名用）。null = 未签名。 */
	signature: AuditSignature | null;
	/** 本轮签名对应的 convlog 行号（防止签名过期复用）。 */
	signatureConvLine: number;
}

const DEFAULT_STATE: AuditState = {
	lastAuditedId: null,
	inFlight: false,
	convExtractedLine: 0,
	roundsSinceAudit: 0,
	pendingChars: 0,
	lastAuditAt: 0,
	signature: null,
	signatureConvLine: 0,
};

/** 审计状态文件路径：<cwd>/.pi/decision-auditor/state.json */
export function auditStatePath(cwd: string): string {
	return path.join(cwd, ".pi", "decision-auditor", "state.json");
}

/** 读审计状态；缺失视为从未审计。 */
export function readAuditState(cwd: string): AuditState {
	try {
		const raw = fs.readFileSync(auditStatePath(cwd), "utf-8");
		const obj = JSON.parse(raw) as Partial<AuditState>;
		return {
			lastAuditedId:
				typeof obj.lastAuditedId === "string" ? obj.lastAuditedId : null,
			inFlight: obj.inFlight === true,
			convExtractedLine:
				typeof obj.convExtractedLine === "number" ? obj.convExtractedLine : 0,
			roundsSinceAudit:
				typeof obj.roundsSinceAudit === "number" ? obj.roundsSinceAudit : 0,
			pendingChars: typeof obj.pendingChars === "number" ? obj.pendingChars : 0,
			lastAuditAt: typeof obj.lastAuditAt === "number" ? obj.lastAuditAt : 0,
			signature:
				obj.signature && typeof obj.signature === "object"
					? (obj.signature as AuditSignature)
					: null,
			signatureConvLine:
				typeof obj.signatureConvLine === "number" ? obj.signatureConvLine : 0,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/** 写审计状态（原子写）。 */
export function writeAuditState(cwd: string, state: AuditState): void {
	const file = auditStatePath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
	fs.renameSync(tmp, file);
}

/**
 * 是否有待签名的工作（完成前审计阶段触发条件）。
 * 判断：convlog 有新增量（本轮有工作）且 最近一次签名未覆盖它。
 */
export function needsSignoff(cwd: string): boolean {
	try {
		const state = readAuditState(cwd);
		const totalLines = convLogLineCount(cwd);
		// 有新增对话且签名未覆盖到当前行 → 需要签名
		return totalLines > state.signatureConvLine;
	} catch {
		return false;
	}
}

/** 记录本轮审计签名（agent 完成审计阶段后调用）。 */
export function recordSignature(
	cwd: string,
	sig: Omit<AuditSignature, "at">,
): void {
	const state = readAuditState(cwd);
	const totalLines = convLogLineCount(cwd);
	writeAuditState(cwd, {
		...state,
		signature: { ...sig, at: Date.now() },
		signatureConvLine: totalLines,
	});
}

/** 自 lastAuditedId 之后的新条目（含 lastAuditedId 自身若从未确认）；从未审计则返回全部。 */
export function entriesSinceLastAudit(cwd: string): DecisionEntry[] {
	const entries = parseChain(readRaw(cwd));
	const state = readAuditState(cwd);
	if (state.lastAuditedId === null) return entries;
	const idx = entries.findIndex((e) => e.id === state.lastAuditedId);
	return idx < 0 ? entries : entries.slice(idx + 1);
}

// ---- 对话流日志（目标推导用）----
// 存 <cwd>/.pi/decision-auditor/convlog.md：只记用户提示 + assistant 最终文本，
// 不含工具调用/代码/思考（不是全文 transcript）。审计者读它推导任务目标。

const CONVLOG_HEADER = `# Conversation Log

<!--
  对话流日志：只记用户提示与 assistant 最终回复（压缩版），供审计者推导任务目标。
  不记录工具调用、代码 diff、思考过程。
-->
`;

/** 对话日志路径：<cwd>/.pi/decision-auditor/convlog.md */
export function convlogPath(cwd: string): string {
	return path.join(cwd, ".pi", "decision-auditor", "convlog.md");
}

/** 追加一条对话（用户提示或 assistant 文本），自动截断单条长度。 */
export function appendConv(
	cwd: string,
	role: "user" | "assistant",
	text: string,
	maxLen = 800,
): void {
	const file = convlogPath(cwd);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(file)) fs.writeFileSync(file, CONVLOG_HEADER, "utf-8");
	const clean = text.replace(/\r?\n/g, " ").trim();
	if (!clean) return;
	const clipped = clean.length > maxLen ? clean.slice(0, maxLen) + "…" : clean;
	const line =
		role === "user" ? `## 👤 用户: ${clipped}` : `## 🤖 助手: ${clipped}`;
	fs.appendFileSync(file, `\n${line}\n`, "utf-8");
}

/** 对话日志尾部（最近 N 条），供审计者读目标。 */
export function readConvTail(cwd: string, maxChars = 12000): string {
	try {
		const raw = fs.readFileSync(convlogPath(cwd), "utf-8");
		if (raw.length <= maxChars) return raw;
		// 保留头部 + 尾部（头部说明格式，尾部是最近对话）
		return (
			raw.slice(0, 200) + "\n\n<!-- 中间省略 -->\n\n" + raw.slice(-maxChars)
		);
	} catch {
		return "（无对话日志）";
	}
}

/** convlog 总行数（不含头注释），用于增量提取定位。只统计对话行（## 👤 / ## 🤖）。 */
export function convLogLineCount(cwd: string): number {
	try {
		const raw = fs.readFileSync(convlogPath(cwd), "utf-8");
		const lines = raw.split(/\r?\n/);
		let count = 0;
		for (const line of lines) {
			const t = line.trim();
			if (t.startsWith("## 👤") || t.startsWith("## 🤖")) {
				count++;
			}
		}
		return count;
	} catch {
		return 0;
	}
}

// ---- 待审增量记账（增量累积唤起）----
// 每轮结束时扩展调用 accumulatePending 记账；达到阈值返回 true 触发审计。

export interface AuditConfig {
	/** 累积多少轮对话触发审计。 */
	batchRounds: number;
	/** 累积多少 convlog 字符触发审计。 */
	batchChars: number;
	/** 两次审计最小间隔（轮），防连续决策密集时频繁唤起。 */
	minIntervalRounds: number;
	/** 决策稀疏时的强制审计兜底（轮）。 */
	maxBatchRounds: number;
}

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
	batchRounds: 6,
	batchChars: 8000,
	minIntervalRounds: 2,
	maxBatchRounds: 15,
};

/** 从环境变量覆盖配置（PI_PAIR_BATCH_ROUNDS 等）。 */
export function resolveAuditConfig(
	env: Record<string, string | undefined> = process.env,
): AuditConfig {
	const num = (k: string, d: number): number => {
		const v = env[k];
		if (!v) return d;
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? Math.round(n) : d;
	};
	return {
		batchRounds: num("PI_PAIR_BATCH_ROUNDS", DEFAULT_AUDIT_CONFIG.batchRounds),
		batchChars: num("PI_PAIR_BATCH_CHARS", DEFAULT_AUDIT_CONFIG.batchChars),
		minIntervalRounds: num(
			"PI_PAIR_MIN_INTERVAL",
			DEFAULT_AUDIT_CONFIG.minIntervalRounds,
		),
		maxBatchRounds: num(
			"PI_PAIR_MAX_BATCH",
			DEFAULT_AUDIT_CONFIG.maxBatchRounds,
		),
	};
}

/**
 * 每轮结束时记账：累计一轮的 convlog 增量。
 * 返回 true 表示达到唤起阈值（应 spawn 审计）。
 * 规则：
 *  - 距上次审计 < minIntervalRounds → 只记账不唤起
 *  - 累积轮数 ≥ batchRounds 或 字符 ≥ batchChars → 唤起
 *  - 累积轮数 ≥ maxBatchRounds → 强制唤起（决策稀疏兜底）
 */
export function accumulatePending(cwd: string, roundChars: number): boolean {
	const cfg = resolveAuditConfig();
	const state = readAuditState(cwd);
	if (state.inFlight) return false;

	const roundsSinceAudit = state.roundsSinceAudit + 1;
	const newState: AuditState = {
		...state,
		roundsSinceAudit,
		pendingChars: state.pendingChars + roundChars,
	};

	// 距离上次审计不足 minInterval → 只记账不唤起
	if (state.lastAuditAt !== 0 && roundsSinceAudit < cfg.minIntervalRounds) {
		writeAuditState(cwd, newState);
		return false;
	}

	const shouldAudit =
		roundsSinceAudit >= cfg.batchRounds ||
		newState.pendingChars >= cfg.batchChars ||
		roundsSinceAudit >= cfg.maxBatchRounds;

	if (shouldAudit) {
		// 触发后清零累积（审计 spawn 时由扩展写 inFlight）
		writeAuditState(cwd, {
			...newState,
			roundsSinceAudit: 0,
			pendingChars: 0,
		});
	} else {
		// 未达阈值：写盘累积，供下次判断
		writeAuditState(cwd, newState);
	}
	return shouldAudit;
}
