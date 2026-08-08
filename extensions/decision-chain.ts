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
	parseChain,
	readAuditState,
	readRaw,
	renderEntry,
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

/** 等待 pi-subagents RPC ready（限时）。 */
function waitForRpcReady(pi: ExtensionAPI, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (off)
				try {
					off();
				} catch {
					/* noop */
				}
			resolve();
		}, timeoutMs);
		const off: (() => void) | undefined = pi.events.on(RPC_READY, () => {
			clearTimeout(timer);
			if (off)
				try {
					off();
				} catch {
					/* noop */
				}
			resolve();
		}) as (() => void) | undefined;
		// 可能已经 ready（后续 /reload）——立即 ping 探测
		pi.events.emit(RPC_REQUEST, {
			version: RPC_VERSION,
			requestId: `decision-auditor-ping-${Date.now()}`,
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
const IN_FLIGHT_TTL_MS = 5 * 60 * 1000; // 5 分钟：审计通常 1-2 分钟完成；超过视为异常允许重试

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
		"你是本会话的结对决策审计者。因对话增量达到阈值被自动唤起。你的职责分两步：先捕获，再审计。",
	);
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导目标与提取决策）`,
	);
	lines.push(`审计状态: ${auditStatePath(cwd)}（含 convExtractedLine 定位已提取位置）`);
	lines.push("");
	lines.push("【第一步：捕获决策（你的新增核心职责）】");
	lines.push(
		"1. 用 read 读对话日志，从 convExtractedLine 标记的行之后开始（状态文件里读）。",
	);
	lines.push(
		"2. 识别主 agent 实际做出的关键决策：方案取舍（选 A 弃 B）、架构/依赖/实现方式改动、采纳的用户要求、推翻之前决策。",
	);
	lines.push(
		"3. 对每个识别出的决策，用 write 工具 **append 追加**到 docs/decisions/chain.md（格式：## D-XXX: 标题 [Accepted]，字段 Context/Decision/Rationale/Alternatives/Confidence/Date）。编号按链中现有最大 D-NNN+1。",
	);
	lines.push(
		"4. 追加后更新 ${auditStatePath(cwd)} 里的 convExtractedLine 为本次读到的最后一行，并清空 pendingRounds/pendingChars。",
	);
	lines.push(
		"5. 若对话日志增量里没有值得入链的决策，也仍推进 convExtractedLine（避免重复读）。",
	);
	lines.push("");
	lines.push("【第二步：审计（对本次捕获 + 链中未审条目）】");
	lines.push("按审计协议执行：");
	lines.push(
		"0. 先推导目标：从对话日志的用户提示推导任务目标。主 agent 自述不可信，以对话记录为准。",
	);
	lines.push(
		"0.5 对照目标审漂移：本次捕获的决策是否服务于目标？",
	);
	lines.push(
		"0.7 独立核实：用 read/grep/find + 只读 bash 去仓库核实 Context 事实。不信任记录，事实不符 = 偏离 ✗。",
	);
	lines.push(
		"1. 逐条审推理链（Context/Decision/Rationale/Alternatives/Confidence）；",
	);
	lines.push(
		"2. 推理存疑、证据不足 → contact_supervisor(interview_request) 问主会话要真实上下文；",
	);
	lines.push("3. 发现链矛盾 → contact_supervisor(need_decision) 请求裁决；");
	lines.push(
		"4. 正确性：决策本身对吗——事实与仓库一致？收益现实？过度设计？",
	);
	lines.push("5. 输出逐条判定（一致 ✓ / 偏离 ✗ / 需裁决 ⚠）+ 链健康度总评。");
	lines.push("");
	lines.push(
		"【收尾】用 write 工具把 ${auditStatePath(cwd)} 的 inFlight 改为 false，lastAuditedId 推进到链最新条目，lastAuditAt 置当前时间。",
	);
	lines.push("写权限仅限：append chain.md + 改 state.json。禁止修改其他任何文件。");
	return lines.join("\n");
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
): Promise<boolean> {
	try {
		// 增量累积记账：达到阈值返回 true
		if (!accumulatePending(cwd, roundChars)) return false;

		const state = readAuditState(cwd);
		if (!state.inFlight && hasInFlight(cwd)) {
			inFlightAudits.delete(cwd);
		}
		if (state.inFlight || hasInFlight(cwd)) return false; // 已有审计在跑

		inFlightAudits.set(cwd, { runId: "", startedAt: Date.now() });
		try {
			await readyPromise;
			const result = await rpc<{ runId?: string; asyncId?: string }>("spawn", {
				agent: AUDITOR_AGENT,
				task: buildIncrementalAuditTask(cwd),
				async: true,
				context: "fresh",
				timeoutMs: 900_000,
			});
			const runId = result?.runId ?? result?.asyncId ?? "";
			inFlightAudits.set(cwd, { runId, startedAt: Date.now() });
			// 审计进行中：置 inFlight（审计者收尾会改 false + 推进 lastAuditedId）
			writeAuditState(cwd, { ...readAuditState(cwd), inFlight: true, lastAuditAt: Date.now() });
			return true;
		} catch {
			inFlightAudits.delete(cwd);
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

export default function (pi: ExtensionAPI): void {
	const rpc = makeRpc(pi);
	const readyPromise = waitForRpcReady(pi);

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
			void maybeAutoAudit(pi, rpc, readyPromise, ctx.cwd, Number.MAX_SAFE_INTEGER);
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
						timeoutMs: 900_000,
					},
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

	// ---- 自动唤起：每轮结束时若有新决策且未审计，自动增量审计（里程碑）----
	pi.on("agent_settled", async (event, ctx) => {
		// 计算本轮 convlog 增量（上次提取位置之后新增的行数），驱动增量累积
		try {
			const state = readAuditState(ctx.cwd);
			const totalLines = convLogLineCount(ctx.cwd);
			const newLines = Math.max(0, totalLines - state.convExtractedLine);
			// 近似字符增量：新行数 × 平均行长（估 100 字符/行，防止 convlog 未写时不误触）
			const roundChars = newLines > 0 ? newLines * 100 : 0;
			void maybeAutoAudit(pi, rpc, readyPromise, ctx.cwd, roundChars);
		} catch {
			void maybeAutoAudit(pi, rpc, readyPromise, ctx.cwd, 1000);
		}
		// 兜底：若文件锁仍为 true 但内存无对应 in-flight（审计者/主会话都没写回），释放锁
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
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content);
				if (text) appendConv(ctx.cwd, "assistant", text);
			}
		} catch {
			/* noop：日志失败不阻塞会话 */
		}
	});

	// ---- 注入：链状态提醒（可关：PI_DECISION_AUDITOR_INJECT=off）----
	if (process.env.PI_DECISION_AUDITOR_INJECT !== "off") {
		pi.on("before_agent_start", async (event, ctx) => {
			try {
				const raw = readRaw(ctx.cwd);
				const entries = parseChain(raw);
				if (entries.length === 0) return;
				const latest = entries
					.slice(-3)
					.map((e) => `${e.id} ${e.summary}`)
					.join("；");
				const pending = entriesSinceLastAudit(ctx.cwd);
				const pendingNote =
					pending.length > 0
						? `，待审计: ${pending.map((e) => e.id).join(", ")}`
						: "";
				return {
					message: {
						customType: "decision-chain-status",
						content:
							`[决策链] ${chainPath(ctx.cwd)} 共 ${entries.length} 条，最新: ${latest}${pendingNote}。` +
							`关键决策用 decision_add 记录后会自动唤起审计；里程碑结束自动审。`,
						display: true,
					},
				};
			} catch {
				return;
			}
		});
	}
}

// 供命令 handler 使用的类型
type ExtensionCommandContext = Parameters<
	Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
>[1];
