// SPDX-License-Identifier: MIT
// 结对决策审计（pi-pair）主扩展
// 提供：decision_add / decision_list 工具、/pair-audit 命令、增量累积自动唤起、链状态轻量注入。

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	accumulatePending,
	appendConv,
	appendDecision,
	auditStatePath,
	chainPath,
	convLogLineCount,
	convlogPath,
	entriesSinceLastAudit,
	listEntries,
	needsSignoff,
	parseChain,
	readAuditState,
	readRaw,
	recordSignature,
	renderEntry,
	resetForSessionStart,
	writeAuditState,
} from "../lib/chain-store.js";

// ---- pi-subagents RPC 通道（进程内事件总线）----
const RPC_READY = "subagents:rpc:v1:ready";
const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;

interface RpcEnvelope {
	version: number;
	requestId: string;
	method: string;
	params?: unknown;
	success?: boolean;
	data?: unknown;
	error?: { code: string; message: string };
}

/** 最小 RPC client：发请求并等待 reply（超时兜底）。pi-subagents 未启用时报错。 */
function makeRpc(pi: ExtensionAPI) {
	return function rpc<T = unknown>(
		method: string,
		params?: unknown,
		timeoutMs = 30_000,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const requestId = `decision-auditor-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
			let off: (() => void) | undefined;
			const timer = setTimeout(() => {
				if (off)
					try {
						off();
					} catch {
						/* noop */
					}
				reject(
					new Error(
						`pi-subagents RPC '${method}' 超时（${timeoutMs}ms）。确认已安装 pi-subagents 扩展。`,
					),
				);
			}, timeoutMs);
			const handler = (data: unknown) => {
				const env = data as RpcEnvelope | null;
				if (!env || env.requestId !== requestId) return;
				if (off)
					try {
						off();
					} catch {
						/* noop */
					}
				clearTimeout(timer);
				if (env.success) resolve(env.data as T);
				else reject(new Error(env.error?.message ?? `RPC '${method}' 失败`));
			};
			off = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, handler);
			pi.events.emit(RPC_REQUEST, {
				version: RPC_VERSION,
				requestId,
				method,
				params,
				source: { extension: "pi-pair" },
			});
		});
	};
}

/** 等待 pi-subagents RPC ready（限时）。ping 真正订阅 reply，收到即返回（不再固定吃满 5s）。 */
function waitForRpcReady(pi: ExtensionAPI, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve) => {
		const requestId = `decision-auditor-ping-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const unsubs: Array<() => void> = [];
		const cleanup = (): void => {
			clearTimeout(timer);
			for (const u of unsubs) {
				try {
					u();
				} catch {
					/* noop */
				}
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(); // 超时兜底
		}, timeoutMs);
		const offReply = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, () => {
			cleanup();
			resolve(); // 收到 ping reply = RPC 就绪
		});
		if (offReply) unsubs.push(offReply);
		const offReady = pi.events.on(RPC_READY, () => {
			cleanup();
			resolve();
		});
		if (offReady) unsubs.push(offReady);
		pi.events.emit(RPC_REQUEST, {
			version: RPC_VERSION,
			requestId,
			method: "ping",
			source: { extension: "pi-pair" },
		});
	});
}

/** 审计触发参数。 */
interface AuditOptions {
	onlyFrom?: string;
	withDiff?: boolean;
	message?: string;
}

/** 从消息 content 提取文本（跳过 tool_use / reasoning 等非文本部分）。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			const p = part as { type?: unknown; text?: unknown };
			if (p.type === "text" && typeof p.text === "string") {
				parts.push(p.text.trim());
			}
		}
	}
	return parts.join("\n").trim();
}

/** 审计状态：正在跑的标志（进程内去重，避免同批新条目重复 spawn）。 */
const inFlightAudits = new Map<string, { runId: string; startedAt: number }>();
const AUDITOR_AGENT = "pi-pair.decision-auditor";
// TTL 对齐 spawn 超时（900s），避免审计运行中锁过期导致并发双审计
const IN_FLIGHT_TTL_MS = 16 * 60 * 1000; // 16 分钟 > spawn timeout 15 分钟

/** cwd 是否有进行中的审计（含 TTL 过期清理）。 */
function hasInFlight(cwd: string): boolean {
	const rec = inFlightAudits.get(cwd);
	if (!rec) return false;
	if (Date.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
		inFlightAudits.delete(cwd);
		return false;
	}
	return true;
}

/** 用 decision-auditor 审 1 条新决策的审计任务文本。 */
function buildIncrementalAuditTask(cwd: string): string {
	const lines: string[] = [];
	lines.push(
		"你是本会话的产物交叉审计者。本轮工作已完成，你负责审计本轮产物。职责：先捕获本轮决策，再审产物忠实性。",
	);
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导目标与提取决策）`,
	);
	lines.push(
		`审计状态: ${auditStatePath(cwd)}（含 convExtractedLine 定位已提取位置）`,
	);
	lines.push(
		"【路径检查】若上述决策链/状态文件不存在：用 ls 检查 cwd 是否仓库根（有 src/ Cargo.toml 等），不是则定位真实项目根再审计。",
	);
	lines.push("");
	lines.push("【第一步：捕获本轮决策】");
	lines.push(
		"1. 用 read 读对话日志，从 convExtractedLine 标记的对话行之后（convExtractedLine = ## 👤/## 🤖 行计数）。",
	);
	lines.push(
		"2. 识别主 agent 本轮实际做的关键决策（方案取舍/架构改动/采纳的用户要求），用 write **append** 到 docs/decisions/chain.md（## D-XXX: 标题 [Accepted]，Context/Decision/Rationale/Alternatives/Confidence/Date，编号 = 现有最大 D-NNN+1）。",
	);
	lines.push(
		`3. 更新 ${auditStatePath(cwd)}：convExtractedLine 推进到最后一条对话行。无决策也推进。`,
	);
	lines.push("");
	lines.push("【第二步：审计本轮产物（核心）】");
	lines.push(
		"1. 先推导目标：从 convlog 用户提示推导任务目标（主 agent 自述不可信）。",
	);
	lines.push(
		"2. 读 git diff（本轮未提交改动），对照本轮捕获的决策审**产物忠实性**：产物是否真的执行了决策？有未执行的决策吗？",
	);
	lines.push(
		"3. 独立核实：用 read/grep 核实 Context 事实与代码一致（不信任记录，事实不符 = 偏离 ✗）。",
	);
	lines.push(
		"4. 审决策链推理（有效性/完整性/一致性/校准）——只审本轮新增条目及其 supersede 关系。",
	);
	lines.push("");
	lines.push("【输出】逐条判定（一致 ✓ / 偏离 ✗ / 需裁决 ⚠）+ 链健康度总评。");
	lines.push("");
	lines.push(
		`【收尾】用 write 更新 ${auditStatePath(cwd)}：inFlight=false，lastAuditedId 推进，lastAuditAt 置当前，roundsSinceAudit/pendingChars 清零。若产物忠实性通过 → signature={status:"passed"}、signatureConvLine 推进到 convlog 当前行；发现 blocker → signature={status:"blocked", blockers:[...]}、signatureConvLine 不推进（待修复）。`,
	);
	lines.push("写权限仅限：append chain.md + 改 state.json。禁止修改其他文件。");
	return lines.join("\n");
}

/**
 * 等待审计完成：轮询 state.json 直到 signatureConvLine 覆盖到 convlog 当前行（审计者已签名）。
 * 返回审计结论（signature）或 null（超时）。timeoutMs 默认 120s（降低阻塞上限）。
 */
async function waitForAuditCompletion(
	cwd: string,
	timeoutMs = 120_000,
	pollMs = 2000,
): Promise<{ status: string; blockers?: string[] } | null> {
	const deadline = Date.now() + timeoutMs;
	const targetLines = convLogLineCount(cwd);
	while (Date.now() < deadline) {
		const state = readAuditState(cwd);
		// 审计者收尾写了 signature 且推进了 signatureConvLine → 审计完成
		if (state.signature && state.signatureConvLine >= targetLines) {
			return {
				status: state.signature.status,
				blockers: state.signature.blockers,
			};
		}
		// 审计者可能失败/被终止：inFlight 被释放但 signature 没推进
		if (!state.inFlight && state.signatureConvLine < targetLines) {
			// 可能审计失败，再等一小段（避免过早放弃），然后返回 null
			await sleep(pollMs);
			continue;
		}
		await sleep(pollMs);
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 自动唤起：基于 convlog 增量累积（accumulatePending），达到阈值时 spawn 审计者
 * （审计者负责从 convlog 提取决策入链 + 审计）。返回是否触发。
 */
async function maybeAutoAudit(
	pi: ExtensionAPI,
	rpc: ReturnType<typeof makeRpc>,
	readyPromise: Promise<void>,
	cwd: string,
	roundChars: number,
	force = false,
): Promise<boolean> {
	try {
		// 增量累积记账：达到阈值返回 true（force=显式 decision_add 跳过 minInterval）
		if (!accumulatePending(cwd, roundChars, force)) return false;

		const state = readAuditState(cwd);
		if (!state.inFlight && hasInFlight(cwd)) {
			inFlightAudits.delete(cwd);
		}
		if (state.inFlight || hasInFlight(cwd)) return false; // 已有审计在跑

		inFlightAudits.set(cwd, { runId: "", startedAt: Date.now() });
		try {
			await readyPromise;
			const result = await rpc<{ runId?: string; asyncId?: string }>(
				"spawn",
				{
					agent: AUDITOR_AGENT,
					task: buildIncrementalAuditTask(cwd),
					async: true,
					context: "fresh",
				},
				900_000, // client 超时：spawn ACK 最长等 15 分钟
			);
			const runId = result?.runId ?? result?.asyncId ?? "";
			inFlightAudits.set(cwd, { runId, startedAt: Date.now() });
			// 审计进行中：置 inFlight（审计者收尾会改 false + 推进 lastAuditedId）
			writeAuditState(cwd, {
				...readAuditState(cwd),
				inFlight: true,
				lastAuditAt: Date.now(),
			});
			return true;
		} catch {
			inFlightAudits.delete(cwd);
			// spawn 失败：回写累积计数，避免已攒的增量丢失（下次继续累积）
			const s = readAuditState(cwd);
			writeAuditState(cwd, {
				...s,
				roundsSinceAudit: (s.roundsSinceAudit ?? 0) + 1,
			});
			return false;
		}
	} catch {
		return false;
	}
}

function buildAuditTask(cwd: string, opts: AuditOptions): string {
	const lines: string[] = [];
	lines.push("你是本会话的结对决策审计者（只读）。");
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导任务目标）`,
	);
	lines.push(
		"【路径检查】若上述决策链不存在：用 ls 检查 cwd 是否为仓库根（有 src/ Cargo.toml 等）；不是则定位真实项目根，审该根下 docs/decisions/chain.md。",
	);
	if (opts.onlyFrom) {
		lines.push(`审计范围: 自 ${opts.onlyFrom} 起的新增决策（含该条）`);
	} else {
		lines.push("审计范围: 决策链全部条目（若链很长，优先最近未审过的）");
	}
	lines.push("");
	lines.push("按审计协议执行：");
	lines.push(
		"0. 先推导目标：用 read 读对话日志，从用户提示中推导任务目标（用户要什么、约束是什么）。主 agent 自述不可信，以对话记录为准。",
	);
	lines.push(
		"0.5 再对照目标审漂移：每条决策是否服务于推导出的目标？还是主 agent 在做目标之外的事？",
	);
	lines.push(
		"0.7 独立核实：用 read/grep/find + 只读 bash（git log/diff、which、python -c import、npm ls 等）去仓库核实 Context 里每个可核实事实（文件/依赖/数字/用户原话）。禁止任何写命令（不 install/commit/rm/写文件）。不信任记录，事实不符 = 偏离 ✗。",
	);
	lines.push(
		"1. 逐条审推理链（Context/Decision/Rationale/Alternatives/Confidence）；",
	);
	lines.push(
		"2. 推理存疑、证据不足 → contact_supervisor(interview_request) 问主会话要真实上下文；",
	);
	lines.push("3. 发现链矛盾 → contact_supervisor(need_decision) 请求裁决；");
	lines.push(
		"4. 正确性：决策本身对吗——事实与仓库一致？收益现实？过度设计？方案技术可行？",
	);
	lines.push("5. 输出逐条判定（一致 ✓ / 偏离 ✗ / 需裁决 ⚠）+ 链健康度总评。");
	lines.push("禁止修改代码和 docs/decisions/chain.md。");
	if (opts.withDiff) {
		lines.push("");
		lines.push(
			"额外要求：读取当前产物 diff（git diff），对照决策链检查产物是否忠实执行了每条决策。",
		);
	}
	if (opts.message) {
		lines.push("");
		lines.push(`主会话补充要求: ${opts.message}`);
	}
	return lines.join("\n");
}

/** L2 交付审查：并行 fanout 多个 fresh reviewer 做产物级深度审查（交付前一次）。 */
const DELIVERY_ANGLES: Array<{
	name: string;
	prompt: (cwd: string) => string;
}> = [
	{
		name: "正确性",
		prompt: (cwd) =>
			`你是交付前独立审查者（角度：正确性/回归）。项目: ${cwd}。\n` +
			`审 git diff（当前未提交改动）与 docs/decisions/chain.md：\n` +
			`1. 改动是否有 bug、边界错误、回归风险；\n` +
			`2. 实现是否忠实执行了决策链中的每条决策（产物 vs 决策对照）；\n` +
			`3. 决策链有无矛盾/悬空 supersede。\n` +
			`输出：按严重度排序的问题清单（文件:行号 + 建议）。只读，不改文件。`,
	},
	{
		name: "目标一致性",
		prompt: (cwd) =>
			`你是交付前独立审查者（角度：目标一致性/漂移）。项目: ${cwd}。\n` +
			`读 .pi/decision-auditor/convlog.md（用户提示记录）推导任务目标，对照 git diff 与决策链：\n` +
			`1. 当前改动是否服务于推导出的用户目标？有无目标外扩张？\n` +
			`2. 决策链条目是否与用户实际要求一致？\n` +
			`3. 主 agent 自述不可信，以 convlog 用户原话为准。\n` +
			`输出：漂移/偏离清单。只读，不改文件。`,
	},
	{
		name: "安全与健壮性",
		prompt: (cwd) =>
			`你是交付前独立审查者（角度：安全/健壮性）。项目: ${cwd}。\n` +
			`审 git diff 与相关文件：\n` +
			`1. 注入/越界/未处理错误/竞态等安全问题；\n` +
			`2. 状态损坏路径（如审计状态文件、并发写）；\n` +
			`3. 不变量破坏（append-only、supersede 语义等）。\n` +
			`输出：按严重度排序的问题清单。只读，不改文件。`,
	},
];

/** 触发 L2 交付审查：并行 spawn 多个 fresh reviewer。 */
async function triggerDeliveryAudit(
	pi: ExtensionAPI,
	rpc: ReturnType<typeof makeRpc>,
	readyPromise: Promise<void>,
	cwd: string,
): Promise<void> {
	// 防重复：交付审查进行中不再触发
	if (deliveryAuditInFlight.has(cwd)) return;
	deliveryAuditInFlight.add(cwd);
	try {
		await readyPromise;
		for (const angle of DELIVERY_ANGLES) {
			try {
				await rpc(
					"spawn",
					{
						agent: "reviewer", // 内置 reviewer（fresh，独立）
						task: angle.prompt(cwd),
						async: true,
						context: "fresh",
					},
					900_000,
				);
			} catch {
				/* 单个角度失败不阻塞其他 */
			}
		}
	} finally {
		setTimeout(() => deliveryAuditInFlight.delete(cwd), 30 * 60 * 1000);
	}
}

const deliveryAuditInFlight = new Set<string>();

export default function (pi: ExtensionAPI): void {
	const rpc = makeRpc(pi);
	const readyPromise = waitForRpcReady(pi);

	// ---- 会话边界：新会话开始清跨会话待签名状态（保留决策链进度）----
	pi.on("session_start", (event, ctx) => {
		try {
			resetForSessionStart(ctx.cwd);
		} catch {
			/* noop */
		}
	});

	// ---- 工具：decision_add（写链，agent 模式）----
	pi.registerTool({
		name: "decision_add",
		label: "Decision Add",
		description:
			"把当前会话的一个关键决策追加到 docs/decisions/chain.md（自动编号、append-only、可声明 supersede）。" +
			"适用于：选择了方案 A 而非 B、架构/依赖/实现方式的关键取舍、被采纳的用户要求。只记录决策本身，代码细节不记。",
		parameters: Type.Object({
			summary: Type.String({
				description: "决策标题，如「采用 Redis 做读缓存」",
			}),
			context: Type.String({
				description: "可验证的事实背景（带数字/来源），不是观点",
			}),
			decision: Type.String({
				description: "选择的内容，如「引入 Redis 缓存读路径」",
			}),
			rationale: Type.String({
				description: "推理：为什么这个选择由 Context 推出",
			}),
			alternatives: Type.Optional(
				Type.String({
					description:
						"考虑过的替代方案与否决理由，如「Memcached（否决：功能少）；本地内存（否决：不可跨实例）」",
				}),
			),
			confidence: Type.Optional(
				Type.Union(
					[Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
					{ description: "置信度（默认 medium）" },
				),
			),
			supersedes: Type.Optional(
				Type.Array(Type.String(), {
					description: '被本条取代的旧决策 id 列表，如 ["D-001"]',
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const entry = appendDecision(ctx.cwd, {
				summary: params.summary,
				context: params.context,
				decision: params.decision,
				rationale: params.rationale,
				alternatives: params.alternatives,
				confidence: params.confidence ?? "medium",
				supersedes: params.supersedes,
			});
			// 自动唤起：新决策落地后立即增量审计（手动 decision_add = 关键决策信号，强制触发）
			void maybeAutoAudit(
				pi,
				rpc,
				readyPromise,
				ctx.cwd,
				Number.MAX_SAFE_INTEGER,
				true, // force：显式 decision_add 跳过 minInterval 节流
			);
			return {
				content: [
					{
						type: "text",
						text: `已追加 ${entry.id}: ${entry.summary} → ${chainPath(ctx.cwd)}`,
					},
				],
				details: { entry: renderEntry(entry) },
			};
		},
	});

	// ---- 工具：decision_list（读链）----
	pi.registerTool({
		name: "decision_list",
		label: "Decision List",
		description:
			"读取决策链 docs/decisions/chain.md。可选 onlyFrom 只看某 id 起的新增条目。审计者与主会话共用。",
		parameters: Type.Object({
			onlyFrom: Type.Optional(
				Type.String({ description: "只列出该 id（含）起的条目，如 D-002" }),
			),
			raw: Type.Optional(
				Type.Boolean({ description: "返回原文而非解析条目（默认 false）" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.raw) {
				return {
					content: [{ type: "text", text: readRaw(ctx.cwd) }],
					details: {},
				};
			}
			const entries = listEntries(ctx.cwd, params.onlyFrom);
			if (entries.length === 0) {
				return {
					content: [{ type: "text", text: "决策链为空（或指定范围无条目）。" }],
					details: {},
				};
			}
			const text = entries.map(renderEntry).join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { count: entries.length },
			};
		},
	});

	// ---- 工具：decision_signoff（签名——解除完成前审计阶段待签名状态）----
	pi.registerTool({
		name: "decision_signoff",
		label: "Decision Signoff",
		description:
			"完成前审计阶段的签名工具。审计通过后调用它把 signature 置为 passed（或 blocked+blockers），解除 needsSignoff 待签名状态。优先用此工具而非手写 state.json。",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("passed"), Type.Literal("blocked")], {
				description: "passed=审计通过；blocked=发现问题（附 blockers）",
			}),
			blockers: Type.Optional(
				Type.Array(Type.String(), {
					description: "blocked 时的发现问题列表",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			recordSignature(ctx.cwd, {
				status: params.status,
				...(params.blockers && params.blockers.length > 0
					? { blockers: params.blockers }
					: {}),
			});
			const sig = readAuditState(ctx.cwd).signature;
			return {
				content: [
					{
						type: "text",
						text: `已签名: ${params.status}${params.blockers?.length ? `（${params.blockers.length} 项 blocker）` : ""} → 完成前审计阶段待签名状态已解除。`,
					},
				],
				details: { signature: sig },
			};
		},
	});

	// ---- 命令：/pair-audit 触发结对审计 ----
	pi.registerCommand("pair-audit", {
		description:
			"触发结对决策审计：spawn decision-auditor 子代理，只读决策链并按审计协议审推理链。参数: [onlyFrom=D-00X] [--diff] [消息]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const opts: AuditOptions = {};
			let rest = (args ?? "").trim();
			const diffMatch = rest.match(/--diff\b/);
			if (diffMatch) {
				opts.withDiff = true;
				rest = rest.replace(/--diff\b/, "").trim();
			}
			const onlyFromMatch = rest.match(/\bD-\d{3,}\b/);
			if (onlyFromMatch) {
				opts.onlyFrom = onlyFromMatch[0];
				rest = rest.replace(onlyFromMatch[0], "").trim();
			}
			if (rest) opts.message = rest;

			const task = buildAuditTask(ctx.cwd, opts);
			try {
				await readyPromise;
				const result = await rpc<{ runId?: string; asyncId?: string }>(
					"spawn",
					{
						agent: "pi-pair.decision-auditor",
						task,
						async: true,
						context: "fresh",
					},
					900_000, // client 超时
				);
				const runId = result?.runId ?? result?.asyncId ?? "";
				ctx.ui.notify(
					`决策审计已启动（async）${runId ? ` run=${runId}` : ""}。完成后会唤醒本会话。`,
					"info",
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(
					`无法启动审计: ${message}\n\n请改用 subagent 工具直接调用: subagent({ agent: "pi-pair.decision-auditor", task: ${JSON.stringify(task)}, async: true, context: "fresh" })`,
					"error",
				);
			}
		},
	});

	// ---- 产物交叉审计（agent_end 阻塞）：本轮有产物 → spawn 审计者并等待完成，签名是结束前提 ----
	pi.on("agent_end", async (event, ctx) => {
		try {
			const state = readAuditState(ctx.cwd);
			const totalLines = convLogLineCount(ctx.cwd);
			// 本轮是否有新产物/决策：convlog 有新增 or 有未审计决策
			const newLines = Math.max(0, totalLines - state.convExtractedLine);
			const hasPending = newLines > 0 || entriesSinceLastAudit(ctx.cwd).length > 0;
			if (!hasPending) return; // 本轮无工作，无需审计

			// 已有审计在跑（inFlight）→ 等待它完成；否则 spawn 新的
			if (!state.inFlight && !hasInFlight(ctx.cwd)) {
				inFlightAudits.set(ctx.cwd, { runId: "", startedAt: Date.now() });
				try {
					await readyPromise;
					const result = await rpc<{ runId?: string; asyncId?: string }>(
						"spawn",
						{
							agent: AUDITOR_AGENT,
							task: buildIncrementalAuditTask(ctx.cwd),
							async: true,
							context: "fresh",
						},
						900_000,
					);
					const runId = result?.runId ?? result?.asyncId ?? "";
					inFlightAudits.set(ctx.cwd, { runId, startedAt: Date.now() });
					writeAuditState(ctx.cwd, {
						...readAuditState(ctx.cwd),
						inFlight: true,
						lastAuditAt: Date.now(),
					});
				} catch {
					inFlightAudits.delete(ctx.cwd);
					// spawn 失败：产物未过审，标记 blocked（不阻塞 end，但状态可见）
					recordSignature(ctx.cwd, { status: "blocked", blockers: ["审计 spawn 失败，产物未过审"] });
					return;
				}
			}

			// 【阻塞等待】审计完成（Pi awaits handler，等待生效）——降低阻塞：只审本轮增量 + 120s 上限
			const sig = await waitForAuditCompletion(ctx.cwd);
			if (sig === null) {
				// 超时：产物未过审，标记（不无限阻塞）
				recordSignature(ctx.cwd, { status: "blocked", blockers: ["审计超时（120s），产物未过审"] });
				return;
			}
			// sig.status 已由审计者写入 state（passed/blocked），agent_end 完成
		} catch {
			/* noop：不崩溃 */
		}
	});

	// ---- 锁兜底：审计完成释放残留锁 ----
	pi.on("agent_settled", async (event, ctx) => {
		try {
			const state = readAuditState(ctx.cwd);
			if (state.inFlight && !hasInFlight(ctx.cwd)) {
				// 内存锁已过期/不存在但文件锁残留——审计大概率已完成，释放
				writeAuditState(ctx.cwd, {
					...state,
					inFlight: false,
				});
			}
		} catch {
			/* noop */
		}
	});

	// ---- 审计完成：清除内存中 in-flight（TTL 兜底在 hasInFlight）----
	// 通过共享事件总线订阅 pi-subagents 的 async-complete 事件
	pi.events.on("subagent:async-complete", (data: unknown) => {
		const env = data as { asyncId?: string; runId?: string } | null;
		const completedId = env?.runId ?? env?.asyncId ?? "";
		for (const [cwd, rec] of inFlightAudits) {
			if (completedId && rec.runId === completedId) {
				inFlightAudits.delete(cwd);
				return;
			}
		}
		// 无法匹配 runId：清除所有已过 TTL 的条目（兜底）
		for (const [cwd, rec] of inFlightAudits) {
			if (Date.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
				inFlightAudits.delete(cwd);
			}
		}
	});

	// ---- 对话流日志：确定性记录用户提示与助手最终回复（不靠主 agent 自记）----
	pi.on("message_end", (event, ctx) => {
		try {
			const msg = event.message as { role?: string; content?: unknown } | null;
			if (!msg) return;
			if (msg.role === "user") {
				const text = extractText(msg.content);
				if (text) appendConv(ctx.cwd, "user", text);
				// L2 交付审查：用户明确要求交付（提交/发布/merge/交付/收工）→ 并行 fanout 深度审查
				if (/提交|发布|merge|交付|收工|上线|部署|推送/.test(text)) {
					void triggerDeliveryAudit(pi, rpc, readyPromise, ctx.cwd);
				}
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content);
				if (text) appendConv(ctx.cwd, "assistant", text);
			}
		} catch {
			/* noop：日志失败不阻塞会话 */
		}
	});
}

// 供命令 handler 使用的类型
type ExtensionCommandContext = Parameters<
	Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
>[1];
