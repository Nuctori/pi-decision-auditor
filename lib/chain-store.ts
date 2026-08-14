// SPDX-License-Identifier: MIT
// 决策链存储：.pi/decision-auditor/chain.md（PI_PAIR_CHAIN_PUBLIC=1 时在 docs/decisions/chain.md）
// （append-only，自动编号，supersede 声明）
// 纯 Node 实现，无第三方依赖。

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

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
	// 默认写 .pi/ 私有目录（不污染项目 git）；PI_PAIR_CHAIN_PUBLIC=1 才写 docs/decisions/（团队可见）
	const publicChain =
		process.env.PI_PAIR_CHAIN_PUBLIC === "1" ||
		process.env.PI_PAIR_CHAIN_PUBLIC === "true";
	return publicChain
		? path.join(cwd, "docs", "decisions", "chain.md")
		: path.join(cwd, ".pi", "decision-auditor", "chain.md");
}

/** 仓库根标记文件/目录：存在任一即视为项目根。 */
const PROJECT_ROOT_MARKERS = [
	"Cargo.toml",
	"package.json",
	"go.mod",
	"pyproject.toml",
	"setup.py",
	"tsconfig.json",
	".git",
	"pom.xml",
	"build.gradle",
];

/**
 * 定位真实项目根（单一权威 state 的关键）：
 * 1. PI_PAIR_PROJECT_ROOT 显式指定 → 直接用（跨盘符/复杂场景的权威根）
 * 2. 否则从 cwd 向上找带仓库根标记的目录，退化到 cwd。
 * 解决"会话在 A 目录启动但项目在 B 目录"的 cwd 错位（chain.md/state.json 应放项目根）。
 * 注意：向上探测限于祖先链，跨盘符（如 C:\ 会话 + D:\ 项目）必须用 PI_PAIR_PROJECT_ROOT。
 */
export function resolveProjectRoot(cwd: string): string {
	const explicit = process.env.PI_PAIR_PROJECT_ROOT;
	if (explicit && explicit.trim()) return path.resolve(explicit.trim());
	try {
		let cur = path.resolve(cwd);
		let best = cur;
		// 向上最多探测 5 层，取最近带仓库标记的目录
		for (let i = 0; i < 5; i++) {
			const hasMarker = PROJECT_ROOT_MARKERS.some((m) =>
				fs.existsSync(path.join(cur, m)),
			);
			if (hasMarker) best = cur;
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
		return best;
	} catch {
		return cwd;
	}
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
	/**
	 * 签名状态：
	 * passed = 审计通过；blocked = 发现问题（streak+1）；
	 * passed-with-warning = 交付轮超时降级 或 连续 blocked 达上限（A2 门禁退出）；
	 * failed = 审计未触发（spawn 失败）——非产物质量问题：不递增 blockedStreak、
	 *          不推进 signatureConvLine（产物未被审计覆盖，下轮 hasWork 时自动重新 spawn）、
	 *          不注入 blockers（不走修复轮）。
	 * 无 timeout 态（v1.0.15 起超时直接降级 passed-with-warning，见 docs/audit-state-machine.md）。
	 */
	status: "passed" | "blocked" | "passed-with-warning" | "failed";
	/** 签名时间（epoch ms）。 */
	at: number;
	/** blocker 摘要（blocked 时）。 */
	blockers?: string[];
	/** failed 原因（审计未触发时，如 spawn 失败）。 */
	reason?: string;
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
	/** 上次审计时间（epoch ms）。 */
	lastAuditAt: number;
	/** 本轮签名（agent_end 强制签名用）。null = 未签名。 */
	signature: AuditSignature | null;
	/** 本轮签名对应的 convlog 行号（防止签名过期复用）。 */
	signatureConvLine: number;
	/** 连续 blocked 次数（A2 门禁退出：>=3 降级放行）。passed 后清零。 */
	blockedStreak: number;
	/** 审计中间态 findings（审计者启动即写、边审边追加；被杀/超时也有中间结果可交付）。 */
	auditFindings: string[];
	/** 最近一次审计的阻塞时长（ms，agent_end 从触发到签名），CI 跑分用。 */
	lastAuditDurationMs: number;
	/** 最近一次审计的启动时间戳（扩展 spawn 时写；审计者收尾算 duration）。 */
	auditStartedAt: number;
	/** 交付门禁基线（上次门禁覆盖的 HEAD 短哈希；持久化——扩展热重载后恢复，防吞修复提交）。 */
	gatedHead: string | null;
}

const DEFAULT_STATE: AuditState = {
	lastAuditedId: null,
	inFlight: false,
	convExtractedLine: 0,
	lastAuditAt: 0,
	signature: null,
	signatureConvLine: 0,
	blockedStreak: 0,
	auditFindings: [],
	lastAuditDurationMs: 0,
	auditStartedAt: 0,
	gatedHead: null,
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
			lastAuditAt: typeof obj.lastAuditAt === "number" ? obj.lastAuditAt : 0,
			signature:
				obj.signature &&
				typeof obj.signature === "object" &&
				!Array.isArray(obj.signature) &&
				(obj.signature as AuditSignature).status !== undefined
					? {
							status: (obj.signature as AuditSignature).status,
							at:
								typeof (obj.signature as AuditSignature).at === "number"
									? (obj.signature as AuditSignature).at
									: 0,
							...(Array.isArray((obj.signature as AuditSignature).blockers)
								? { blockers: (obj.signature as AuditSignature).blockers }
								: {}),
							...(typeof (obj.signature as AuditSignature).runId === "string"
								? { runId: (obj.signature as AuditSignature).runId }
								: {}),
							...(typeof (obj.signature as AuditSignature).reason === "string"
								? { reason: (obj.signature as AuditSignature).reason }
								: {}),
						}
					: null,
			signatureConvLine:
				typeof obj.signatureConvLine === "number" ? obj.signatureConvLine : 0,
			blockedStreak:
				typeof obj.blockedStreak === "number" ? obj.blockedStreak : 0,
			auditFindings: Array.isArray(obj.auditFindings)
				? obj.auditFindings.filter((x) => typeof x === "string")
				: [],
			lastAuditDurationMs:
				typeof obj.lastAuditDurationMs === "number"
					? obj.lastAuditDurationMs
					: 0,
			auditStartedAt:
				typeof obj.auditStartedAt === "number" ? obj.auditStartedAt : 0,
			gatedHead: typeof obj.gatedHead === "string" ? obj.gatedHead : null,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/** state.json 当前 mtime（epoch ms）；不存在返回 null。多写者乐观锁用。 */
export function auditStateMtime(cwd: string): number | null {
	try {
		return fs.statSync(auditStatePath(cwd)).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * 写审计状态（原子写 + mtime 乐观锁）。
 * expectedMtime 提供时：写前校验当前 mtime 是否仍等于它——不匹配（其他写者已改，
 * read-modify-write 竞态）→ 放弃本次提交（防丢失更新），console.warn 后返回 false。
 * 无 expectedMtime（新初始化）照写。返回是否写入。
 */
export function writeAuditState(
	cwd: string,
	state: AuditState,
	expectedMtime?: number | null,
): boolean {
	const file = auditStatePath(cwd);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (expectedMtime !== undefined) {
		const cur = auditStateMtime(cwd);
		if (cur !== expectedMtime) {
			console.warn(
				`audit state 冲突，放弃提交（多写者）: ${file} cur=${cur} expected=${expectedMtime}`,
			);
			return false;
		}
	}
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
	fs.renameSync(tmp, file);
	return true;
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

/** 记录本轮审计签名（agent 完成审计阶段后调用）。签名即审计结束：释放 inFlight 锁。
 * 多写者防护：读后写前校验 mtime，冲突（他写者已改）→ 重读最新重试一次。 */
export function recordSignature(
	cwd: string,
	sig: Omit<AuditSignature, "at">,
): void {
	for (let attempt = 0; attempt < 2; attempt++) {
		const state = readAuditState(cwd);
		const mtime = auditStateMtime(cwd);
		const totalLines = convLogLineCount(cwd);
		// A2 门禁：连续 blocked 递增；passed / 降级放行后清零。（timeout 态已移除，见 docs/audit-state-machine.md）
		// failed（审计未触发/spawn 失败）：非产物问题，不递增 streak。
		const blockedStreak =
			sig.status === "blocked"
				? state.blockedStreak + 1
				: sig.status === "failed"
					? state.blockedStreak
					: 0;
		// failed 不推进 signatureConvLine——审计未发生，产物未被审计覆盖，下轮 hasWork 时自动重新 spawn，不得假装已审计。
		const nextConvLine =
			sig.status === "failed" ? state.signatureConvLine : totalLines;
		const ok = writeAuditState(
			cwd,
			{
				...state,
				// 签名 = 审计结束：释放文件锁（防 decision_signoff 路径泄漏 inFlight → 后续审计永久停摆）
				inFlight: false,
				signature: { ...sig, at: Date.now() },
				signatureConvLine: nextConvLine,
				blockedStreak,
			},
			mtime,
		);
		if (ok || attempt > 0) return; // 冲突重试一次仍失败 → 放弃（防覆盖他写者）
	}
}

/**
 * 会话边界重置（session_start 调用）：新会话开始时清掉跨会话的待签名状态。
 * 保留：决策链审计进度（lastAuditedId / convExtractedLine）——跨会话延续。
 * 清零：signatureConvLine 推进到当前 convlog 行数（旧会话未签名工作不强制新会话开头就审）。
 */
export function resetForSessionStart(cwd: string): void {
	try {
		const state = readAuditState(cwd);
		const mtime = auditStateMtime(cwd);
		const totalLines = convLogLineCount(cwd);
		writeAuditState(
			cwd,
			{
				...state,
				// 推进到当前行数 = 视为已覆盖旧会话的对话（不触发 needsSignoff）
				signatureConvLine: totalLines,
				// 保留上次签名状态作参考，但不再触发待签名
				inFlight: false,
			},
			mtime,
		);
	} catch {
		/* noop */
	}
}

/** 自 lastAuditedId 之后的新条目（含 lastAuditedId 自身若从未确认）；从未审计则返回全部。 */
export function entriesSinceLastAudit(cwd: string): DecisionEntry[] {
	const entries = parseChain(readRaw(cwd));
	const state = readAuditState(cwd);
	if (state.lastAuditedId === null) return entries;
	const idx = entries.findIndex((e) => e.id === state.lastAuditedId);
	return idx < 0 ? entries : entries.slice(idx + 1);
}

/**
 * 是否有未提交的真实产物（git 未提交改动/新增文件，排除扩展自身状态目录）。
 * agent_end 触发判据的一半：无代码产物且无对话增量 → 本轮不审计（纯咨询/运维会话零审计零噪音；
 * 对话增量触发的语义判断交给审计者 AI 第零步，见 hasNewConversation）。
 * 排除 .pi/ 与 .pi-subagents/（审计状态/convlog/链自身写入不算产物，防自触发）。
 * 非 git 仓库或 git 不可用 → false（对话增量判据兜底触发）。
 */
export function hasUncommittedChanges(cwd: string): boolean {
	try {
		const out = execFileSync(
			"git",
			[
				"status",
				"--porcelain",
				"--untracked-files=all",
				"--",
				":(exclude).pi",
				":(exclude).pi-subagents",
			],
			{
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5000,
			},
		);
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * 对话增量判据：convlog 对话行数是否超过 convExtractedLine（上次审计者已检查的位置）。
 * 触发语义：有新的对话（用户提问/助手回复）→ spawn 审计者，由审计者 AI 判定本轮是否有
 * 值得审计的工作（决策性工作或产物）。纯咨询会话审计者会判"无工作"快速退出并推进游标。
 * 不做正则信号词判定（模式匹配无法可靠识别决策——漏检/误检），语义判断交给审计者。
 */
export function hasNewConversation(
	cwd: string,
	extractedLine: number,
): boolean {
	try {
		return convLogLineCount(cwd) > extractedLine;
	} catch {
		return false;
	}
}

/**
 * 单位钳制（B2 修复）：审计者写 convExtractedLine 可能用文件行号（read 工具自然单位），
 * 而扩展按 convLogLineCount（只计 ## 👤/## 🤖 对话行）比较——审计者写超（文件行号 >
 * 对话行数）会让"对话增量"触发永久断线。钳制到对话行数：写超视为"已读完当前全部对话"。
 * 纯读：不落盘——落盘由调用方（扩展 agent_end）在 inFlight 锁处理之后统一做，
 * 避免在谓词求值中与审计者进程的 state.json 读-改-写形成竞态（reviewer Medium）。
 */
export function clampConvExtractedLine(cwd: string): number {
	const total = convLogLineCount(cwd);
	const state = readAuditState(cwd);
	return state.convExtractedLine > total ? total : state.convExtractedLine;
}

/** 纯咨询轮审计者写入的 findings 占位——不算真实中间态（跨会话注入过滤用，防零注入承诺被打破）。 */
export const PURE_CHAT_PLACEHOLDER = "本轮纯咨询，无审计对象";

/**
 * 中间态注入判据（B1 行为级测试目标，从扩展 handler 抽出的纯函数）：
 * 注入 ⇔ 有真实 findings（非纯咨询占位）且 同轮未注入过，且满足其一：
 *  - inFlight===true：审计在跑（被杀时文件锁残留）——中途被杀/超时的部分发现；
 *  - signature===null：审计未收尾（会话早结被杀后新会话 reset 清 inFlight 的场景——
 *    中间态跨会话交付，边界 3）。
 * 纯咨询轮：inFlight=false + findings=[占位] → 占位过滤后空 → 不注入（零注入承诺，D-006）。
 * 审计正常收尾（signature 已写）：中间态不再注入，价值走 signature 通道（blockers）。
 */
export function shouldInjectInterimFindings(
	state: AuditState,
	injectedAt: number | undefined,
): boolean {
	if (state.auditFindings.length === 0 || injectedAt === state.auditStartedAt) {
		return false;
	}
	if (!state.auditFindings.some((f) => f !== PURE_CHAT_PLACEHOLDER)) {
		return false;
	}
	return state.inFlight === true || state.signature === null;
}

/**
 * 残留锁兜底判据（v1.0.21 行为级测试目标，从 agent_end 抽出的纯函数）：
 * 文件锁 inFlight=true 但内存锁已无（审计者被强杀未写收尾）→ 应释放文件锁。
 * 位置语义（先于 hasWork 判断执行——纯咨询轮也清锁）由接线守卫的 indexOf 顺序断言锁定，
 * 这里只锁定判据本身：清锁**不依赖** hasWork 信号（清锁≠spawn，不违反零噪音承诺）。
 */
export function shouldClearStaleLock(
	state: AuditState,
	hasInMemoryLock: boolean,
): boolean {
	return state.inFlight === true && !hasInMemoryLock;
}

/**
 * 当前 git HEAD（客观信号）：交付门禁用「本轮产生了提交」判定，不用词表/模式匹配
 * （完工是语义判断，模式匹配不可靠——v1.0.17 废弃 hasNewDecisionSignals 的先例；
 * 问句/任意措辞天然免疫：不产生提交就不触发）。非 git 仓库返回 null（无门禁）。
 */
export function gitHead(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000, // 与 hasUncommittedChanges 一致：git 挂起（损坏 .git/杀软锁）不得阻塞 agent_end
		});
		return out.trim() || null;
	} catch {
		return null;
	}
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

/** 追加一条对话（用户提示或 assistant 文本），自动截断单条长度。
 *  runId：调用方（扩展实例）唯一标识，写入行尾 `<!--run:<id>-->`。
 *  convlog 按 cwd 定位、多实例共享追加——审计者凭该标记过滤出本会话的行，
 *  避免把同 cwd 下其他 pi 实例（其他会话/审计者 run）的对话误当本会话决策。 */
export function appendConv(
	cwd: string,
	role: "user" | "assistant",
	text: string,
	runId?: string,
	maxLen = 800,
): void {
	const file = convlogPath(cwd);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(file)) fs.writeFileSync(file, CONVLOG_HEADER, "utf-8");
	const clean = text.replace(/\r?\n/g, " ").trim();
	if (!clean) return;
	const clipped = clean.length > maxLen ? clean.slice(0, maxLen) + "…" : clean;
	const tag = runId ? ` <!--run:${runId}-->` : "";
	const line =
		role === "user"
			? `## 👤 用户: ${clipped}${tag}`
			: `## 🤖 助手: ${clipped}${tag}`;
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

/** 过程日志（process.md）：只记主 agent 的意图/决策信号（高信号过滤），不记工具调用流水。
 *  审计者读它对照"意图轨迹"审产物（不反推），降低 agent_end 阻塞时间。
 *  信号词命中才记、单条 ≤200 字符、超 100 条滚动截断——体积小，成本可忽略。 */
const PROCESS_HEADER = `# Process Log

<!--
  意图轨迹：只记 assistant 回复中命中决策信号词的高信号摘要。
  不记工具调用/中间产物/调试输出（避免膨胀）。审计者对照它审产物。
-->
`;

/** 决策信号词：命中才记录（强信号，避免每轮都记）。 */
const PROCESS_SIGNAL_RE =
	/决定|采用|放弃|选择|方案|架构|重构|改为|引入|移除|迁移|升级|降级|替代|否决|supersede|不采用|采纳/i;

/** 过程日志路径：<cwd>/.pi/decision-auditor/process.md */
export function processPath(cwd: string): string {
	return path.join(cwd, ".pi", "decision-auditor", "process.md");
}

/**
 * 追加一条意图信号（高信号过滤）：assistant 回复命中决策信号词才记录。
 * 单条 ≤200 字符截断；文件超 100 条滚动截断（保留最近 50 条）。
 * runId：与 convlog 同源的多实例隔离键（行尾 `<!--run:<id>-->`），
 * 避免其他 pi 实例的意图信号污染本会话审计者的意图轨迹对照。
 * 返回是否记录了。
 */
export function appendProcessSignal(
	cwd: string,
	text: string,
	runId?: string,
): boolean {
	if (!PROCESS_SIGNAL_RE.test(text)) return false;
	const clean = text.replace(/\r?\n/g, " ").trim();
	if (!clean) return false;
	const clipped = clean.length > 200 ? clean.slice(0, 200) + "…" : clean;

	const file = processPath(cwd);
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(file)) fs.writeFileSync(file, PROCESS_HEADER, "utf-8");
	const tag = runId ? ` <!--run:${runId}-->` : "";
	fs.appendFileSync(file, `\n- 🤔 ${clipped}${tag}\n`, "utf-8");

	// 滚动截断：正文行（非注释）超 100 条 → 保留最近 50 条 + 头注释
	try {
		const raw = fs.readFileSync(file, "utf-8");
		const lines = raw.split(/\r?\n/);
		const body = lines.filter((l) => l.startsWith("- 🤔"));
		if (body.length > 100) {
			const keep = body.slice(-50);
			fs.writeFileSync(
				file,
				PROCESS_HEADER + "\n" + keep.join("\n") + "\n",
				"utf-8",
			);
		}
	} catch {
		/* noop */
	}
	return true;
}

/** 过程日志全文（供审计者读意图轨迹；文件小，直接全读）。 */
export function readProcess(cwd: string, maxChars = 8000): string {
	try {
		const raw = fs.readFileSync(processPath(cwd), "utf-8");
		if (raw.length <= maxChars) return raw;
		return (
			raw.slice(0, 200) + "\n\n<!-- 中间省略 -->\n\n" + raw.slice(-maxChars)
		);
	} catch {
		return "（无过程日志）";
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

/**
 * 检测 convlog 中"并发其他 pi 实例的真实用户行"数量（多实例混写检测）。
 * 判定：本实例首行**之后**（实时交错追加）、带 runId 标记、非本实例、且非审计任务
 * 注入（Task: 前缀）的 ## 👤 行。
 * >0 → 同一 cwd 下存在**并发**实例的真实会话 → 自动审计应跳过（run 级过滤 vs 全局
 * 状态机错配时，多实例下审计会错审/旁路，显式降级优于静默错审）。
 * 本实例首行**之前**的历史行（已结束的旧会话）不算——convlog 按 cwd 永久追加，
 * 若计入历史行则第二个会话起守卫恒 >0，自动审计永久停摆（实证：本仓 165+97 行
 * 历史 run 标记曾导致复审永不触发）。并发检测只需一侧命中：先启动的实例会在
 * 后启动实例首行之后继续追加，先启动方必然检测到后者。
 * 无标记行（旧代码历史/未升级实例）无法归属，不误报。
 */
export function convlogForeignRuns(cwd: string, ownRunId: string): number {
	try {
		const raw = fs.readFileSync(convlogPath(cwd), "utf-8");
		const lines = raw.split(/\r?\n/);
		// 本实例首行（行尾锚定的真实标记，防正文伪造）——首行前 = 历史，首行后 = 并发窗口
		const ownTag = `<!--run:${ownRunId}-->`;
		let firstOwn = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trimEnd().endsWith(ownTag)) {
				firstOwn = i;
				break;
			}
		}
		if (firstOwn < 0) return 0; // 本实例尚未写入（首条消息之前），无可判定
		let n = 0;
		for (let i = firstOwn + 1; i < lines.length; i++) {
			const t = lines[i].trim();
			if (!t.startsWith("## 👤")) continue; // 只看用户行
			// 真实标记由 appendConv 追加在行尾——锚定行尾取真标记，防用户正文内嵌
			// `<!--run:xxx-->` 文本被误判为外来实例（伪造即可关闭审计门禁）
			const m = t.match(/<!--run:([a-zA-Z0-9-]+)-->\s*$/);
			if (!m) continue; // 无标记（旧历史/未升级实例）——无法归属，不误报
			if (m[1] === ownRunId) continue; // 本实例
			if (t.includes("Task:")) continue; // 审计者任务注入（user-role 记录），非真实会话
			n++;
		}
		return n;
	} catch {
		return 0;
	}
}

// ---- 待审增量记账（增量累积唤起）----
// 已删除：L0 独立层（accumulateRound/checkAuditDue/AuditConfig）——单层审计在 agent_end
// 直接按两个便宜信号判定（hasUncommittedChanges or hasNewConversation）触发，无需累积记账。
