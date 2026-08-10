// SPDX-License-Identifier: MIT
// 结对决策审计（pi-pair）主扩展
// 提供：decision_add / decision_list 工具、/pair-audit 命令、增量累积自动唤起、链状态轻量注入。

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	accumulateRound,
	appendConv,
	appendDecision,
	appendProcessSignal,
	auditStatePath,
	chainPath,
	checkAuditDue,
	convLogLineCount,
	convlogPath,
	entriesSinceLastAudit,
	listEntries,
	needsSignoff,
	parseChain,
	processPath,
	readAuditState,
	readProcess,
	readRaw,
	recordSignature,
	renderEntry,
	resetForSessionStart,
	resolveProjectRoot,
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
		"你是本会话的产物交叉审计者（L1 门禁）。本轮工作已完成，你负责审计本轮产物并签名。注意：捕获决策入链是 L0 审计者的职责（它攒够增量才跑），你只审产物。",
	);
	lines.push(
		"【窗口约束】你在 agent_end 的阻塞窗口内运行，本轮产物已完整（不会有后续产物）。直接给结论，不要假设还有后续；发现 blocker 就给可操作的 blockers（主 agent 靠它当场修复）。",
	);
	lines.push(
		"【修复验证】若 state.json 的 signature.status 存在且为 blocked（上一轮审计失败触发的修复轮），先验证其 blockers 是否已修复：已修复 → 判 passed；未修复或只部分修复 → 判 blocked 并更新 blockers。",
	);
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导目标）`,
	);
	lines.push(`审计状态: ${auditStatePath(cwd)}（含签名状态与 blockedStreak）`);
	lines.push(
		"【路径检查】若上述决策链/状态文件不存在：用 ls 检查 cwd 是否仓库根（有 src/ Cargo.toml 等），不是则定位真实项目根（向上找 Cargo.toml/package.json/go.mod/.git）再审计；链的实际位置以 find 到的真实文件为准（指定路径可能因 cwd 解析不准而缺失）。",
	);
	lines.push("");
	lines.push("【第一步：推导目标】");
	lines.push(
		"1. 用 read 读对话日志末尾（convlog 最后几条），从用户原话推导本轮任务目标（主 agent 自述不可信）。",
	);
	lines.push(
		`2. 用 read 读过程日志（${processPath(cwd)}）——主 agent 的意图轨迹（决策信号摘要），对照它理解‘为什么这么做’，审产物时核对产物是否偏离了过程中表达的意图。`,
	);
	lines.push(
		"3. 读决策链已有条目（chainPath 下的 chain.md），找与本轮相关的最近决策作为对照基准。",
	);
	lines.push("");
	lines.push("【第二步：审计本轮产物（核心，对抗式）】");
	lines.push(
		"立场：产物默认有缺陷（guilty until proven innocent）。不要‘检查有没有错’——要主动尝试推翻：每个维度找具体缺陷，找到 = 偏离 ✗；五个维度全部无法推翻才判通过。",
	);
	lines.push(
		"1. 读 git diff（本轮未提交改动），按五维度逐项进攻：① 原子性（独立评审/回滚？混入无关主题？）② 正确性（逻辑/边界/错误路径真的对？事实与仓库一致？）③ 一致性（决策间/实现与决策/既有模式一致？）④ 内聚（一个决策一个主题？职责放对？过度设计？）⑤ 完备（边界/错误/依赖/文档/测试覆盖？产物真的执行了本轮目标？）。",
	);
	lines.push(
		"2. 独立核实：用 read/grep 核实涉及的事实与代码一致（不信任记录，事实不符 = 偏离 ✗）。",
	);
	lines.push(
		"3. 【两个实证盲区维度，必查】⑥ 机制完整性：若产物含触发机制（事件→函数→状态写入），用 grep 验证每一环有实际调用点且可达——不是死代码/从未被触发（例：声称每轮记账唤起审计，但事件处理里没有调用 = 偏离 ✗）。⑦ 运行时行为 vs 声明：产物声称‘阻塞/异步/完成后 X’时，确认该行为在 print / TUI / RPC 各模式下都成立；模式相关则标注差异（例：print 模式可能不等待扩展 handler 的 async 完成）。",
	);
	lines.push("");
	lines.push("【输出】逐条判定（一致 ✓ / 偏离 ✗ / 需裁决 ⚠）+ 产物总评。");
	lines.push("");
	lines.push(
		`【收尾】用 write 更新 ${auditStatePath(cwd)}：inFlight=false，lastAuditedId 推进，lastAuditAt 置当前。产物通过 → signature={status:"passed"}、signatureConvLine 推进到 convlog 当前行；发现 blocker → signature={status:"blocked", blockers:[...具体可操作缺口]}、signatureConvLine 不推进。不要清 roundsSinceAudit/pendingChars（那是 L0 的累积记账，不归你管）。不要写 chainFindings（L0 的职责）。`,
	);
	lines.push(
		"写权限仅限：改 state.json。禁止修改任何其他文件（决策链由 L0 审计者维护，你不碰）。",
	);
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
			// 阻塞时长在轮询循环内写（print 模式下 handler 尾段可能不执行，这里最可靠）
			if (state.auditStartedAt) {
				try {
					writeAuditState(cwd, {
						...readAuditState(cwd),
						lastAuditDurationMs: Date.now() - state.auditStartedAt,
					});
				} catch {
					/* noop */
				}
			}
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

/** A2 门禁：连续 blocked 达到该次数后降级放行（end 就是 end，不再触发修复轮）。 */
const MAX_BLOCKED_STREAK = 3;

/**
 * C1 窗口约束：审计超时后尝试终止审计者 run（防它在窗口外继续跑并发起联系）。
 * pi-subagents RPC 可能不支持 stop——try/catch 后靠审计者协议约束兜底。
 */
/** 协商中止收尾窗口：steer 发消息后，给审计者签名收尾的时间（超时总阻塞 ≤ 120s + 30s）。 */
const NEGOTIATE_WINDOW_MS = 30_000;

/**
 * 协商中止（不直接 kill）：审计超时后先 steer 通知审计者协商，
 * 给它机会收尾——能立即给结论（哪怕 blockers 摘要）就签名，否则确认中止。
 * 协商窗口内完成签名 → 返回 true（采纳结论）；无响应 → 兜底 stop 并返回 false。
 */
async function negotiateStop(
	rpc: ReturnType<typeof makeRpc>,
	cwd: string,
): Promise<boolean> {
	try {
		const state = readAuditState(cwd);
		const runId = state.signature?.runId ?? state.auditorRunId;
		if (!runId) return false;

		// 1. steer 发协商消息（不立即 stop）——目标是快速反馈已发现的问题，而非等完整审计
		try {
			await rpc(
				"steer",
				{
					id: runId,
					message:
						'【协商中止】审计窗口（120s）已超时。请立即把你当前已发现的问题整理成 blockers，用 decision_signoff(status="blocked", blockers=[...]) 签名——主 agent 会马上确认并修复，不必等完整审计。若确认无问题，签名 passed；若无法给出结论，回复确认中止。',
				},
				10_000,
			);
		} catch {
			/* steer 失败（run 已结束等）→ 走兜底 */
		}

		// 2. 协商窗口内轮询：审计者是否完成签名收尾
		const deadline = Date.now() + NEGOTIATE_WINDOW_MS;
		const targetLines = convLogLineCount(cwd);
		while (Date.now() < deadline) {
			const s = readAuditState(cwd);
			if (s.signature && s.signatureConvLine >= targetLines) return true; // 收尾完成，采纳结论
			await sleep(2000);
		}

		// 3. 兜底：协商无果 → 强制 stop（防止窗口外继续跑并发起联系）
		try {
			await rpc("stop", { id: runId }, 10_000);
		} catch {
			/* RPC 不支持 stop 时静默（审计者协议禁止窗口外联系兜底） */
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * B1 门禁失败处理：blocked 后当场修复（followUp）或 A2 降级放行。
 * 修复轮：sendUserMessage(followUp) 排队，Pi 在 agent_settled 前处理 → 主 agent 当场修 → 下轮 agent_end 再审计。
 */
async function handleBlocked(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
): Promise<void> {
	try {
		const state = readAuditState(cwd);
		const blockers = state.signature?.blockers?.join("; ") ?? "未知";
		if (state.blockedStreak < MAX_BLOCKED_STREAK) {
			// B1：当场修复（第 streak 次），修复完成后自动再审计
			pi.sendUserMessage(
				`⚠ 结对审计未通过（第 ${state.blockedStreak}/${MAX_BLOCKED_STREAK} 次）。请当场修复以下缺口，修复完成后将自动再次审计；若无法修复，请在回复中明确告知用户审计未完成及缺口。\n\n缺口：${blockers}`,
				{ deliverAs: "followUp" },
			);
		} else {
			// A2：连续 blocked 达上限 → 降级放行（passed-with-warning），end 就是 end
			recordSignature(cwd, {
				status: "passed-with-warning",
				blockers: state.signature?.blockers,
			});
			try {
				ctx.ui.notify(
					`结对审计连续 ${MAX_BLOCKED_STREAK} 次未通过，已降级放行（警告）。缺口：${blockers}`,
					"warning",
				);
			} catch {
				/* print/无 UI 模式降级 */
			}
		}
	} catch {
		/* noop */
	}
}

/**
 * 自动唤起：基于 convlog 增量累积（accumulatePending），达到阈值时 spawn 审计者
 * （审计者负责从 convlog 提取决策入链 + 审计）。返回是否触发。
 */
/** L0 链维护审计的进行中标记（内存；不占 state.inFlight——那是 L1 门禁的锁，避免 L0 抢阻塞窗口）。 */
const l0AuditsInFlight = new Map<string, { startedAt: number }>();

/** L0 链维护审计任务：批量捕获增量决策 + 链级复审（对抗式），不签名（签名是 L1 门禁职责）。 */
function buildChainAuditTask(cwd: string): string {
	const lines: string[] = [];
	lines.push(
		"你是本会话的链维护审计者（L0）。触发原因：对话累积达到阈值，需要批量捕获增量决策 + 链级复审。",
	);
	lines.push(
		"【窗口约束】你在 agent_settled 后非阻塞运行（不在 agent_end 阻塞窗口内）——禁止 contact_supervisor（不得唤起主 agent）、禁止签名（签名是 L1 产物门禁的职责）。有疑问写进 chainFindings，主 agent 下轮开工时会看到。",
	);
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复）`);
	lines.push(
		`审计状态: ${auditStatePath(cwd)}（含 convExtractedLine 定位已提取位置）`,
	);
	lines.push("");
	lines.push("【任务一：捕获增量决策（核心）】");
	lines.push(
		"1. 用 read 读对话日志，从 convExtractedLine 标记的对话行之后开始（convExtractedLine = ## 👤/## 🤖 行计数）。",
	);
	lines.push(
		`2. 识别主 agent 实际做的关键决策（方案取舍/架构改动/采纳的用户要求），用 write **append** 到 ${chainPath(cwd)}（## D-XXX: 标题 [Accepted]，Context/Decision/Rationale/Alternatives/Confidence/Date，编号 = 现有最大 D-NNN+1）。`,
	);
	lines.push(
		`3. 更新 ${auditStatePath(cwd)}：convExtractedLine 推进到最后一条对话行。无决策也推进。`,
	);
	lines.push("");
	lines.push("【任务二：链级复审（对抗式）】");
	lines.push(
		"对链上自上次 lastAuditedId 以来的新增条目（或最近 10 条），按五维度对抗审链：① 原子性（条目自足？）② 正确性（Context 事实与仓库一致？）③ 一致性（跨轮矛盾？Supersedes 断裂？）④ 内聚（一个决策一个主题？）⑤ 完备（关键取舍入链了？有遗漏决策？）。立场：条目默认有缺陷，尝试推翻。",
	);
	lines.push("");
	lines.push(
		"【收尾】用 write 更新 state.json：inFlight=false，lastAuditedId 推进，lastAuditAt 置当前；发现链级问题 → chainFindings=[...具体可操作问题，主 agent 下轮处理]；无问题 → chainFindings=[]。不签名（signature 不动，那是 L1 的）。不要清 roundsSinceAudit/pendingChars（扩展在触发时已清）。",
	);
	lines.push("写权限仅限：append chain.md + 改 state.json。禁止修改其他文件。");
	return lines.join("\n");
}

/**
 * L0 链维护审计唤起（agent_settled / decision_add 调用，非阻塞）：
 * 独立内存锁（不占 state.inFlight，避免抢 L1 门禁的阻塞窗口）；spawn 后不 await。
 */
async function spawnL0Audit(
	pi: ExtensionAPI,
	rpc: ReturnType<typeof makeRpc>,
	readyPromise: Promise<void>,
	cwd: string,
): Promise<boolean> {
	// L0 防重：内存锁（独立于 L1 的 inFlight）
	const rec = l0AuditsInFlight.get(cwd);
	if (rec && Date.now() - rec.startedAt < IN_FLIGHT_TTL_MS) return false;
	l0AuditsInFlight.set(cwd, { startedAt: Date.now() });
	try {
		await readyPromise;
		await rpc<{ runId?: string; asyncId?: string }>(
			"spawn",
			{
				agent: AUDITOR_AGENT,
				task: buildChainAuditTask(cwd),
				async: true,
				context: "fresh",
			},
			900_000, // client 超时：spawn ACK 最长等 15 分钟
		);
		return true;
	} catch {
		l0AuditsInFlight.delete(cwd);
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
			resetForSessionStart(resolveProjectRoot(ctx.cwd));
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
			const entry = appendDecision(resolveProjectRoot(ctx.cwd), {
				summary: params.summary,
				context: params.context,
				decision: params.decision,
				rationale: params.rationale,
				alternatives: params.alternatives,
				confidence: params.confidence ?? "medium",
				supersedes: params.supersedes,
			});
			// 自动唤起：新决策落地后立即链维护审计（手动 decision_add = 关键决策信号，force 跳过节流）
			if (checkAuditDue(resolveProjectRoot(ctx.cwd), true)) {
				void spawnL0Audit(pi, rpc, readyPromise, resolveProjectRoot(ctx.cwd));
			}
			return {
				content: [
					{
						type: "text",
						text: `已追加 ${entry.id}: ${entry.summary} → ${chainPath(resolveProjectRoot(ctx.cwd))}`,
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
					content: [
						{ type: "text", text: readRaw(resolveProjectRoot(ctx.cwd)) },
					],
					details: {},
				};
			}
			const entries = listEntries(resolveProjectRoot(ctx.cwd), params.onlyFrom);
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
			recordSignature(resolveProjectRoot(ctx.cwd), {
				status: params.status,
				...(params.blockers && params.blockers.length > 0
					? { blockers: params.blockers }
					: {}),
			});
			const sig = readAuditState(resolveProjectRoot(ctx.cwd)).signature;
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

			const task = buildAuditTask(resolveProjectRoot(ctx.cwd), opts);
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
	// ---- L0 findings 注入：上一轮链级复审的问题带给主 agent（低优先级，不阻塞）----
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const state = readAuditState(resolveProjectRoot(ctx.cwd));
			if (state.chainFindings && state.chainFindings.length > 0) {
				return {
					message: {
						customType: "pi-pair-findings",
						content: `【链级复审发现（L0）】请留意以下决策链问题（可顺手处理或忽略）：\n${state.chainFindings.map((f) => `- ${f}`).join("\n")}`,
						display: false, // 不打扰用户，只给主 agent
					},
				};
			}
		} catch {
			/* noop */
		}
	});

	/** 记录审计阻塞时长（agent_end 从触发到签名，CI 跑分用）。 */
	function recordAuditDuration(cwd: string, t0: number): void {
		try {
			writeAuditState(cwd, {
				...readAuditState(cwd),
				lastAuditDurationMs: Date.now() - t0,
			});
		} catch {
			/* noop */
		}
	}

	pi.on("agent_end", async (event, ctx) => {
		try {
			const state = readAuditState(resolveProjectRoot(ctx.cwd));
			const totalLines = convLogLineCount(resolveProjectRoot(ctx.cwd));
			// 本轮是否有新产物/决策：convlog 有新增 or 有未审计决策
			const newLines = Math.max(0, totalLines - state.convExtractedLine);
			const hasPending =
				newLines > 0 ||
				entriesSinceLastAudit(resolveProjectRoot(ctx.cwd)).length > 0;
			if (!hasPending) return; // 本轮无工作，无需审计

			const t0 = Date.now(); // 审计阻塞计时起点

			// 已有审计在跑（inFlight）→ 等待它完成；否则复用常驻审计者 或 首次 spawn
			if (!state.inFlight && !hasInFlight(resolveProjectRoot(ctx.cwd))) {
				inFlightAudits.set(resolveProjectRoot(ctx.cwd), {
					runId: "",
					startedAt: Date.now(),
				});
				// auditStartedAt 在 spawn/resume 的 rpc await **之前**写：
				// print 模式下 handler 可能在 rpc await 处被丢弃，写在之后会丢（CI 跑分 duration=0）
				writeAuditState(resolveProjectRoot(ctx.cwd), {
					...readAuditState(resolveProjectRoot(ctx.cwd)),
					inFlight: true,
					lastAuditAt: Date.now(),
					auditStartedAt: Date.now(),
				});
				try {
					await readyPromise;
					const task = buildIncrementalAuditTask(resolveProjectRoot(ctx.cwd));
					// 复用常驻审计者：resume 同一个 run（带 session 历史 + 命中缓存），否则首次 spawn
					if (state.auditorRunId) {
						await rpc(
							"resume",
							{
								id: state.auditorRunId,
								message: task,
							},
							900_000,
						);
					} else {
						const result = await rpc<{ runId?: string; asyncId?: string }>(
							"spawn",
							{
								agent: AUDITOR_AGENT,
								task,
								async: true,
								context: "fresh",
							},
							900_000,
						);
						const runId = result?.runId ?? result?.asyncId ?? "";
						// 记住常驻审计者 runId（跨轮 resume）
						if (runId) {
							writeAuditState(resolveProjectRoot(ctx.cwd), {
								...readAuditState(resolveProjectRoot(ctx.cwd)),
								auditorRunId: runId,
							});
						}
						inFlightAudits.set(resolveProjectRoot(ctx.cwd), {
							runId,
							startedAt: Date.now(),
						});
					}
				} catch {
					inFlightAudits.delete(resolveProjectRoot(ctx.cwd));
					// spawn/resume 失败：释放 inFlight 锁 + 产物未过审标记 blocked
					writeAuditState(resolveProjectRoot(ctx.cwd), {
						...readAuditState(resolveProjectRoot(ctx.cwd)),
						inFlight: false,
					});
					recordSignature(resolveProjectRoot(ctx.cwd), {
						status: "blocked",
						blockers: ["审计触发失败，产物未过审"],
					});
					return;
				}
			}

			// 【阻塞等待】审计完成（Pi awaits handler，等待生效）——降低阻塞：只审本轮增量 + 120s 上限
			const sig = await waitForAuditCompletion(resolveProjectRoot(ctx.cwd));
			recordAuditDuration(resolveProjectRoot(ctx.cwd), t0);
			if (sig === null) {
				// 超时：协商中止——steer 通知审计者快速反馈已发现的问题，收尾窗口内采纳其结论
				const settled = await negotiateStop(rpc, resolveProjectRoot(ctx.cwd));
				recordAuditDuration(resolveProjectRoot(ctx.cwd), t0); // 协商时长计入阻塞
				if (settled) {
					// 协商窗口内审计者已签名 → 采纳结论（passed=门禁通过；blocked=快速确认修复）
					const s = readAuditState(resolveProjectRoot(ctx.cwd));
					if (
						s.signature &&
						(s.signature.status === "passed" ||
							s.signature.status === "passed-with-warning")
					) {
						return; // B1 门禁通过
					}
					await handleBlocked(pi, ctx, resolveProjectRoot(ctx.cwd));
					return;
				}
				// 协商无果 → 超时按 blocked 计（递增 streak），进修复循环或降级放行
				recordSignature(resolveProjectRoot(ctx.cwd), {
					status: "timeout",
					blockers: ["审计超时（120s），协商中止后产物未过审"],
				});
				await handleBlocked(pi, ctx, resolveProjectRoot(ctx.cwd));
				return;
			}
			// 审计者已签名（passed/blocked/timeout），blockedStreak 已由 recordSignature 递增/清零
			if (sig.status === "passed" || sig.status === "passed-with-warning") {
				return; // B1 门禁通过，end 就是 end
			}
			// blocked：B1 当场修复（streak<上限）或 A2 降级放行（streak>=上限）
			await handleBlocked(pi, ctx, resolveProjectRoot(ctx.cwd));
		} catch {
			/* noop：不崩溃 */
		}
	});

	// ---- 锁兜底：审计完成释放残留锁 + L0 链维护审计触发（非阻塞，L1 门禁之后）----
	pi.on("agent_settled", async (event, ctx) => {
		try {
			const root = resolveProjectRoot(ctx.cwd);
			const state = readAuditState(root);
			if (state.inFlight && !hasInFlight(root)) {
				// 内存锁已过期/不存在但文件锁残留——审计大概率已完成，释放
				writeAuditState(root, { ...state, inFlight: false });
			}
			// L0：累积达阈值 → 链维护审计（非阻塞；L1 门禁之后触发，不抢阻塞窗口）
			if (checkAuditDue(root)) {
				void spawnL0Audit(pi, rpc, readyPromise, root);
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
			}
		}
		// 无法匹配 runId：清除所有已过 TTL 的条目（兜底）
		for (const [cwd, rec] of inFlightAudits) {
			if (Date.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
				inFlightAudits.delete(cwd);
			}
		}
		// L0 链维护审计锁同样清理（TTL 兜底）
		for (const [cwd, rec] of l0AuditsInFlight) {
			if (Date.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
				l0AuditsInFlight.delete(cwd);
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
				if (text) appendConv(resolveProjectRoot(ctx.cwd), "user", text);
				// L2 交付审查：用户明确要求交付（提交/发布/merge/交付/收工）→ 并行 fanout 深度审查
				if (/提交|发布|merge|交付|收工|上线|部署|推送/.test(text)) {
					void triggerDeliveryAudit(
						pi,
						rpc,
						readyPromise,
						resolveProjectRoot(ctx.cwd),
					);
				}
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content);
				if (text) {
					appendConv(resolveProjectRoot(ctx.cwd), "assistant", text);
					// L0 记账：每轮累计 convlog 增量（达到阈值后 agent_settled 触发链维护审计）
					accumulateRound(resolveProjectRoot(ctx.cwd), text.length);
					// 意图信号记录（高信号过滤，≤200 字符；PI_PAIR_PROCESS_LOG=0 关闭——CI 跑分基线用）
					if (process.env.PI_PAIR_PROCESS_LOG !== "0") {
						appendProcessSignal(resolveProjectRoot(ctx.cwd), text);
					}
				}
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
