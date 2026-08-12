// SPDX-License-Identifier: MIT
// 结对决策审计（pi-pair）主扩展
// 提供：decision_add / decision_list 工具、/pair-audit 命令、增量累积自动唤起、链状态轻量注入。

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	appendConv,
	appendDecision,
	appendProcessSignal,
	auditStatePath,
	chainPath,
	clampConvExtractedLine,
	convLogLineCount,
	convlogForeignRuns,
	convlogPath,
	entriesSinceLastAudit,
	hasNewConversation,
	hasUncommittedChanges,
	listEntries,
	parseChain,
	processPath,
	readAuditState,
	readProcess,
	readRaw,
	recordSignature,
	renderEntry,
	resetForSessionStart,
	resolveProjectRoot,
	shouldInjectInterimFindings,
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

/** 本扩展实例唯一标识（进程 + 随机）：convlog 按 cwd 多实例共享追加的隔离键。
 *  审计者凭 `<!--run:${RUN_ID}-->` 过滤出本会话的对话行，排除同 cwd 下
 *  其他 pi 实例（其他会话 / 审计者 run 自身输出）的内容。 */
const RUN_ID = `run-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

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
		"你是本会话的结对审计者（单层）。本轮工作已完成，你负责：① 从对话提取关键决策入链（不靠主 agent 自觉）② 审计本轮产物并签名。两件事一次完成。",
	);
	lines.push(
		"【窗口约束】常规轮你在 agent_end 之后异步运行（主 agent 已结束本轮，不阻塞等待你）——本轮产物已完整（不会有后续产物），直接给结论；发现 blocker 就给可操作的 blockers。交付轮（用户提交/发布/merge 时）主 agent 会同步等你的签名，此时尽快收尾：若审计超时，主 agent 会降级放行并把你的 blockers 注入下轮。",
	);
	lines.push(
		"【中间态交付（最重要，任何时刻被杀都要有产出）】用 write 更新 state.json 时**先写中间态再继续**：启动后立即写 auditFindings 占位（如 ['审计开始']）；每完成一步核实（推导目标 ✓ / 提取决策 ✓ / 读 diff ✓ / 逐维度进攻 ✓），就把该步的已确认事实与已发现缺口**追加**进 auditFindings。你随时可能被超时终止（SIGINT 强杀，收尾来不及）——已写入的 auditFindings 就是你的部分审计结果，主 agent 下轮会读到并交付给用户。**宁可中间态多写，不可最后一起写**：最后一步签名（passed/blocked）只是收尾，auditFindings 才是价值交付的主通道。**中间态写入必须保留 inFlight=true**（仅收尾签名时写 inFlight=false）——扩展按 inFlight===true 判定「审计被中断」并注入中间态，提前置 false 会让被杀后的 findings 无法交付。",
	);
	lines.push(
		"【完成即停（明确边界）】一旦你写完了最终 signature（passed/blocked），审计即结束——**立即停止，不再追加、不再验证、不再扩大范围**。签名后的一切继续都是浪费。任何遗留疑问写进 blockers/auditFindings，留给下一轮会话结合用户需求再继续。",
	);
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导目标与提取决策）`,
	);
	lines.push(
		`【会话隔离】convlog 由同一 cwd 下多个 pi 实例共享追加：本会话行 = 带 \`<!--run:${RUN_ID}-->\` 标记的行，推导目标/提取决策只依据它们；无标记行（升级前历史/无法归属）仅作上下文理解、不得据此推导；其他 run 标记的行（其他实例的对话、审计者 run 自己的输出）一律忽略。`,
	);
	lines.push(
		`审计状态: ${auditStatePath(cwd)}（含签名状态、convExtractedLine 与 auditFindings）`,
	);
	lines.push(
		"【路径检查】若上述决策链/状态文件不存在：用 ls 检查 cwd 是否仓库根（有 src/ Cargo.toml 等），不是则定位真实项目根（向上找 Cargo.toml/package.json/go.mod/.git）再审计；链的实际位置以 find 到的真实文件为准（指定路径可能因 cwd 解析不准而缺失）。",
	);
	lines.push("");
	lines.push("【第零步：判定本轮是否有值得审计的工作（先做这个）】");
	lines.push(
		"用 read 读对话日志增量（convlog 自 convExtractedLine 之后）。判断本轮是否有**决策性工作**（方案取舍/采纳用户要求/架构决定/推翻旧决策）或**产物**（代码改动/文件）。",
	);
	lines.push(
		"**若本轮纯咨询**（如技术对比问答、信息查询，无决策无产物）：**快速退出**——用 write 更新 state.json：inFlight=false、convExtractedLine 推进到当前对话行总数（只数 `## 👤`/`## 🤖` 行，不是文件行号）、auditFindings=['本轮纯咨询，无审计对象']，**不写 signature 不注入任何价值点**（用户零感知）。退出后立即停止。",
	);
	lines.push(
		"**若有决策性工作或产物**：继续以下步骤——提取决策入链 + 审决策/产物质量 + 签名。",
	);
	lines.push("【第一步：提取增量决策入链】");
	lines.push(
		"1. 用 read 读对话日志，从 state.json 的 convExtractedLine 标记的对话行之后开始（convExtractedLine = ## 👤/## 🤖 行计数）。",
	);
	lines.push(
		`2. 识别主 agent 实际做的关键决策（方案取舍/架构改动/采纳的用户要求），用 write **append** 到 ${chainPath(cwd)}（## D-XXX: 标题 [Accepted]，Context/Decision/Rationale/Alternatives/Confidence/Date，编号 = 现有最大 D-NNN+1）。不记：命名、格式、单文件实现细节。`,
	);
	lines.push(
		"3. 用 write 更新 state.json：convExtractedLine 推进到当前对话行总数（单位：只数 `## 👤`/`## 🤖` 开头的行，不是文件行号；写错单位会被扩展钳制，但写对可避免重审）。无决策也推进。",
	);
	lines.push("");
	lines.push("【第二步：推导目标】");
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
	lines.push("【第三步：审计本轮产物（核心，对抗式）】");
	lines.push(
		"立场：产物默认有缺陷（guilty until proven innocent）。不要‘检查有没有错’——要主动尝试推翻：每个维度找具体缺陷，找到 = 偏离 ✗；五个维度全部无法推翻才判通过。",
	);
	lines.push(
		"1. **有 git diff（未提交改动）**：按五维度逐项进攻①原子性 ②正确性 ③一致性 ④内聚 ⑤完备（详见维度定义）。**plan 阶段无 git diff**：审决策质量——本轮提取的决策条目是否自足（Context 可验证/Decision 明确/Rationale 由 Context 推出/Alternatives 认真考虑）？决策是否服务于推导出的目标（有无漂移）？",
	);
	lines.push("2. **独立核实（两层，缺一不可）**：");
	lines.push(
		"   ① 收敛核实（对账）：用 read/grep 核实产物/决策中**声明的每个事实**与代码/仓库一致（不信任记录，事实不符 = 偏离 ✗）。——这层只证明「声明的没错」。",
	);
	lines.push(
		"   ② 发散核实（主动找未声明的风险——对抗式的另一半）：在目标/决策/产物三个锚点内**主动发散**，找出产物没声明但影响结果的因素。具体攻击点：a) 未声明的假设——产物依赖了什么隐含前提（数据规模/时序/权限/单写者）？前提不成立会怎样？b) 被忽略的替代方案——还有没有更简单的做法？当前选择是唯一解还是惰性解？c) 边界反例——输入/状态/并发/失败路径的极端情况产物没覆盖？d) 跨层盲区——决策链条目之间、产物与既有模式之间有没有没说破的冲突？e) 二阶效应——这个改动/决策的后续影响（维护成本/迁移/依赖）有没有被忽略？f) 跨领域知识迁移——把**其他领域/项目/范式**中同类问题的已知失败模式迁移过来审视：这个实现/决策在其他语境下犯过的错（缓存穿透/竞态/状态机遗漏/约定冲突/规模拐点）在这里会不会重演？当前方案与成熟范式（CAP/ACID/幂等/背压等）的偏差是有意取舍还是无知？**发散要可控**：每个发散点必须能落回「产物/决策的某个具体缺口」，落不回的猜想不算发现，写进 auditFindings 供参考即可。",
	);
	lines.push(
		"   发散核实抓到的问题与收敛核实同等权重：找到 = 偏离 ✗（blockers 写具体可操作缺口）。",
	);
	lines.push(
		"3. 【两个实证盲区维度，必查】⑥ 机制完整性：若产物含触发机制（事件→函数→状态写入），用 grep 验证每一环有实际调用点且可达——不是死代码/从未被触发（例：声称每轮记账唤起审计，但事件处理里没有调用 = 偏离 ✗）。⑦ 运行时行为 vs 声明：产物声称‘阻塞/异步/完成后 X’时，确认该行为在 print / TUI / RPC 各模式下都成立；模式相关则标注差异（例：print 模式可能不等待扩展 handler 的 async 完成）。",
	);
	lines.push("");
	lines.push("【输出】逐条判定（一致 ✓ / 偏离 ✗ / 需裁决 ⚠）+ 产物总评。");
	lines.push("");
	lines.push(
		`【收尾】用 write 更新 ${auditStatePath(cwd)}：inFlight=false，lastAuditedId 推进，lastAuditAt 置当前。产物通过 → signature={status:"passed", at:<当前 epoch ms>}、signatureConvLine 推进到当前对话行总数；发现 blocker → signature={status:"blocked", at:<当前 epoch ms>, blockers:[...具体可操作缺口]}、signatureConvLine 同样推进（签名即推进——修复走 blockers 注入通道，不靠 convLine 滞后）。**signature 必须带 at 字段**（值 = lastAuditAt，epoch ms）——扩展按 signature.at ≥ auditStartedAt 判定审计完成，缺 at 会被交付轮误判为超时。**保留 auditFindings（中间态历史不删）**。写完后立即停止。`,
	);
	lines.push(
		"写权限仅限：append chain.md + 改 state.json。禁止修改任何其他文件。",
	);
	return lines.join("\n");
}

/**
 * 等待审计完成：轮询 state.json 直到 signatureConvLine 覆盖到 convlog 当前行（审计者已签名）。
 * 返回审计结论（signature）或 null（超时）。
 * timeoutMs = 300s 阻塞上限：到点降级放行 + findings 下轮注入（无协商黑洞）。
 */
async function waitForAuditCompletion(
	cwd: string,
	timeoutMs = 300_000,
	pollMs = 2000,
): Promise<{ status: string; blockers?: string[] } | null> {
	const deadline = Date.now() + timeoutMs;
	const state0 = readAuditState(cwd);
	const startedAt = state0.auditStartedAt || 0;
	while (Date.now() < deadline) {
		const state = readAuditState(cwd);
		// 完成判定：本轮审计写入的新签名（signature.at >= 本轮 auditStartedAt）即完成——
		// blocked 也是完成（签名即推进 convLine，但完成判定只看 at），交付轮不得误判为超时（High-1）
		// B5 代码兜底：审计者手写 signature 漏 at（消毒为 0）时，用 lastAuditAt 判定——
		// 收尾写会把 lastAuditAt 置当前，故 lastAuditAt >= startedAt 且 !inFlight = 刚签名完成；
		// 旧轮签名（无 at）的 lastAuditAt 早于本轮 startedAt，不会被误判。
		if (
			state.signature &&
			(state.signature.at >= startedAt ||
				(state.signature.at === 0 && state.lastAuditAt >= startedAt)) &&
			!state.inFlight
		) {
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
		await sleep(pollMs);
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A2 门禁：连续 blocked 达到该次数后降级放行（end 就是 end，不再触发修复轮）。 */
const MAX_BLOCKED_STREAK = 3;

function buildAuditTask(cwd: string, opts: AuditOptions): string {
	const lines: string[] = [];
	lines.push("你是本会话的结对决策审计者（只读）。");
	lines.push(`项目目录: ${cwd}`);
	lines.push(`决策链: ${chainPath(cwd)}`);
	lines.push(
		`对话日志: ${convlogPath(cwd)}（只记用户提示与助手最终回复，供你推导任务目标）`,
	);
	lines.push(
		`【会话隔离】convlog 由同一 cwd 下多个 pi 实例共享追加：本会话行 = 带 \`<!--run:${RUN_ID}-->\` 标记的行，推导目标只依据它们；无标记行（升级前历史/无法归属）仅作上下文理解、不得据此推导目标；其他 run 标记的行（其他实例的对话、审计者 run 自己的输出）一律忽略。`,
	);
	lines.push(
		"【路径检查】若上述决策链不存在：用 ls 检查 cwd 是否为仓库根（有 src/ Cargo.toml 等）；不是则定位真实项目根，链的实际位置以 find 到的真实文件为准（默认 .pi/decision-auditor/chain.md，PI_PAIR_CHAIN_PUBLIC=1 时在 docs/decisions/chain.md）。",
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
	lines.push(`禁止修改代码和 ${chainPath(cwd)}。`);
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
			`审 git diff（当前未提交改动）与 ${chainPath(cwd)}（默认 .pi/decision-auditor/chain.md，PI_PAIR_CHAIN_PUBLIC=1 时在 docs/decisions/chain.md）：\n` +
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
			`注意 convlog 由同一 cwd 下多个 pi 实例共享追加——本会话行 = 带 \`<!--run:${RUN_ID}-->\` 标记的行，推导目标只依据它们；无标记行（升级前历史/无法归属）仅作上下文、不得据此推导；其他 run 标记行（其他实例/审计者输出）忽略：\n` +
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

	// ---- 会话级单一项目根（单一权威 state 的关键）：首次解析后固定，全部 handler 共用 ----
	let cachedProjectRoot: string | null = null;
	const projectRoot = (cwd: string): string => {
		if (cachedProjectRoot) return cachedProjectRoot;
		const root = resolveProjectRoot(cwd);
		if (root) cachedProjectRoot = root;
		return root;
	};

	// ---- 会话边界：新会话重置根缓存（重新解析）+ 清跨会话待签名状态 ----
	// 目标架构：fresh spawn（无常驻 run、无生命周期登记）——session_shutdown 只清内存锁
	pi.on("session_start", (event, ctx) => {
		try {
			cachedProjectRoot = null; // 新会话重新解析（或读 PI_PAIR_PROJECT_ROOT）
			resetForSessionStart(projectRoot(ctx.cwd));
		} catch {
			/* noop */
		}
	});
	pi.on("session_shutdown", () => {
		// fresh spawn 无残留 run 可停；仅清内存锁与根缓存
		inFlightAudits.clear();
		cachedProjectRoot = null;
	});

	// ---- 工具：decision_add（写链，agent 模式）----
	pi.registerTool({
		name: "decision_add",
		label: "Decision Add",
		description:
			"把当前会话的一个关键决策追加到决策链（自动编号、append-only、可声明 supersede）。" +
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
			const entry = appendDecision(projectRoot(ctx.cwd), {
				summary: params.summary,
				context: params.context,
				decision: params.decision,
				rationale: params.rationale,
				alternatives: params.alternatives,
				confidence: params.confidence ?? "medium",
				supersedes: params.supersedes,
			});
			// 单层审计：新决策落地即触发审计（agent_end 时统一 spawn，这里不额外唤起）
			return {
				content: [
					{
						type: "text",
						text: `已追加 ${entry.id}: ${entry.summary} → ${chainPath(projectRoot(ctx.cwd))}`,
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
			"读取决策链（默认 .pi/decision-auditor/chain.md）。可选 onlyFrom 只看某 id 起的新增条目。审计者与主会话共用。",
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
					content: [{ type: "text", text: readRaw(projectRoot(ctx.cwd)) }],
					details: {},
				};
			}
			const entries = listEntries(projectRoot(ctx.cwd), params.onlyFrom);
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
			recordSignature(projectRoot(ctx.cwd), {
				status: params.status,
				...(params.blockers && params.blockers.length > 0
					? { blockers: params.blockers }
					: {}),
			});
			const sig = readAuditState(projectRoot(ctx.cwd)).signature;
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

			const task = buildAuditTask(projectRoot(ctx.cwd), opts);
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

	// ---- 交付轮标记：message_end 检测到交付词 → agent_end 同步等签名（门禁），常规轮异步 ----
	const deliveryRequested = new Set<string>();
	// ---- findings 注入去重：两个独立 map 防互相覆盖（D1）----
	// signature 结论注入去重（记录已注入的 signature.at，变化才再注入）
	const injectedSignatureAt = new Map<string, number>();
	// 中间态注入去重（记录已注入的 auditStartedAt，同轮审计只注入一次）
	const injectedInterimAt = new Map<string, number>();

	// ---- 产物交叉审计（agent_end）：本轮有真实产物 → spawn 审计者；交付轮同步等签名，常规轮异步不阻塞 ----
	// ---- L0 findings 注入：上一轮链级复审的问题带给主 agent（低优先级，不阻塞）----
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const root = projectRoot(ctx.cwd);
			const state = readAuditState(root);
			// 价值点注入（用户可观察）：blockers 结论与中间态发现——审计抓出的
			// 具体缺口是价值，必须让用户看到（可感知），而非流程噪音（等待/计数/协商才隐藏）
			const valueMsgs: string[] = [];
			// 审计结论注入（价值点，用户可观察）：signature 变化才注入
			if (
				state.signature &&
				(state.signature.status === "blocked" ||
					state.signature.status === "passed-with-warning") &&
				state.signature.blockers &&
				state.signature.blockers.length > 0 &&
				injectedSignatureAt.get(root) !== state.signature.at
			) {
				valueMsgs.push(
					`结对审计发现 ${state.signature.blockers.length} 个缺口（价值点）：\n${state.signature.blockers.map((b) => `- ${b}`).join("\n")}\n\n请修复这些缺口（修复后下轮自动再审）；若无法修复请说明。`,
				);
				injectedSignatureAt.set(root, state.signature.at ?? Date.now());
			}
			// 审计中间态注入（价值点，用户可观察）：审计进行中被杀/超时时留下的部分结果 → 交付价值而非丢弃；
			// 判据 = shouldInjectInterimFindings 纯函数（行为级测试锁定）：inFlight===true（审计仍在跑 = 中断；
			// 纯咨询轮审计者主动写 inFlight=false，不注入——零注入承诺，D-006）；同轮去重（injectedInterimAt）
			if (shouldInjectInterimFindings(state, injectedInterimAt.get(root))) {
				valueMsgs.push(
					`结对审计进行中被中断，已确认的部分发现（价值点）：\n${state.auditFindings.map((f) => `- ${f}`).join("\n")}\n\n供参考，可据此继续处理。`,
				);
				injectedInterimAt.set(root, state.auditStartedAt ?? Date.now());
			}
			// 价值点 → display:true（用户可观察）
			if (valueMsgs.length > 0) {
				return {
					message: {
						customType: "pi-pair-findings",
						content: valueMsgs.join("\n\n"),
						display: true, // 审计抓出的价值点：用户必须感知（可观察）
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
			const root = projectRoot(ctx.cwd);
			const state = readAuditState(root);
			// 交付标记先消费（任何早退路径都不泄漏到下轮——Medium-2）
			const isDelivery = deliveryRequested.has(root);
			deliveryRequested.delete(root);
			// 工作判据（两个便宜信号，无需语义理解——语义判断交给审计者 AI）：
			// 1. 有代码产物（git 未提交改动）→ 必审
			// 2. 有对话增量（convlog 新对话行）→ spawn 审计者，它 AI 判定是否有决策性工作/产物；
			//    纯咨询 → 判"无工作"快速退出（推进游标，零注入）；plan 阶段 → 提取决策入链 + 审决策
			// convExtractedLine 先经单位钳制（审计者可能写文件行号，超界会让增量触发断线——B2）
			const hasWork =
				hasUncommittedChanges(root) ||
				hasNewConversation(root, clampConvExtractedLine(root));
			if (!hasWork) return;

			// 多实例混写检测：同 cwd 下存在其他实例的真实用户行 → 自动审计会错审/旁路
			// （run 级过滤 vs 全局状态机错配），显式跳过并警告，不静默错审
			if (convlogForeignRuns(root, RUN_ID) > 0) {
				try {
					ctx.ui.notify(
						"⚠ 检测到同一 cwd 下多个 pi 实例共享 convlog（存在其他实例的真实对话），本轮自动审计已跳过——多实例场景下审计会错审。在不同目录运行或设 PI_PAIR_PROJECT_ROOT 指向单一项目根后恢复。",
						"warning",
					);
				} catch {
					/* print/无 UI 模式降级 */
				}
				return;
			}

			// 交付轮（用户消息含 提交/发布/merge 等交付信号）→ 同步等签名（硬门禁）；
			// 常规轮 → 异步 spawn，不阻塞——审计者完成写 signature，findings 下轮注入
			const t0 = Date.now(); // 审计阻塞计时起点

			// 已有审计在跑（inFlight）→ 等待它完成；否则 fresh spawn 审计者
			// 残留锁兜底：文件锁 inFlight=true 但内存锁已无（审计者被强杀未写收尾）→ 释放
			// （防该 cwd 审计永久停摆——Medium-4；agent_settled 兜底已删，这里补回）
			// clamp 持久化（B2）合并进这个写点：避免在谓词求值中与审计者进程读-改-写竞态（reviewer Medium）
			if (state.inFlight && !hasInFlight(root)) {
				writeAuditState(root, {
					...readAuditState(root),
					inFlight: false,
					convExtractedLine: clampConvExtractedLine(root),
				});
			}
			if (!state.inFlight && !hasInFlight(root)) {
				inFlightAudits.set(root, {
					runId: "",
					startedAt: Date.now(),
				});
				// auditStartedAt 在 spawn 的 rpc await **之前**写：
				// print 模式下 handler 可能在 rpc await 处被丢弃，写在之后会丢（CI 跑分 duration=0）
				// convExtractedLine 钳制合并进这个写点（spawn 前唯一全量写，无审计者并发）
				writeAuditState(root, {
					...readAuditState(root),
					inFlight: true,
					lastAuditAt: Date.now(),
					auditStartedAt: Date.now(),
					convExtractedLine: clampConvExtractedLine(root),
				});
				try {
					await readyPromise;
					const task = buildIncrementalAuditTask(root);
					// fresh spawn（不常驻）+ context:"fork" 继承主会话上下文——
					// 审计者理解"同一会话"在做什么，而非从零开始
					const result = await rpc<{ runId?: string; asyncId?: string }>(
						"spawn",
						{
							agent: AUDITOR_AGENT,
							task,
							async: true,
							context: "fork",
						},
						900_000,
					);
					const runId = result?.runId ?? result?.asyncId ?? "";
					inFlightAudits.set(root, {
						runId,
						startedAt: Date.now(),
					});
				} catch {
					inFlightAudits.delete(root);
					// spawn 失败：释放 inFlight 锁 + 产物未过审标记 blocked
					writeAuditState(root, {
						...readAuditState(root),
						inFlight: false,
					});
					recordSignature(root, {
						status: "blocked",
						blockers: ["审计触发失败，产物未过审"],
					});
					return;
				}
			}

			// 常规轮：异步审计不阻塞——end 就是 end，审计者完成签名后下轮注入 findings
			if (!isDelivery) return;

			// 交付轮：同步门禁（阻塞等签名，300s 上限）
			const sig = await waitForAuditCompletion(root);
			recordAuditDuration(root, t0);
			if (sig === null) {
				// 超时：不再 600s 协商黑洞——降级放行，缺口经 before_agent_start 注入下轮
				recordSignature(root, {
					status: "passed-with-warning",
					blockers: [
						"审计超时（300s），已降级放行；上轮审计未完成，缺口将在下轮注入",
					],
				});
				return;
			}
			// 审计者已签名（passed/blocked），blockedStreak 已由 recordSignature 递增/清零
			if (sig.status === "passed" || sig.status === "passed-with-warning") {
				return; // 门禁通过，end 就是 end
			}
			// blocked：A2 连续超限降级放行；未超限保留 blocked，缺口已注入（下轮开工主 agent 收到）
			const s = readAuditState(root);
			if (s.blockedStreak >= MAX_BLOCKED_STREAK) {
				recordSignature(root, {
					status: "passed-with-warning",
					blockers: s.signature?.blockers,
				});
			}
		} catch {
			/* noop：不崩溃 */
		}
	});

	// ---- 审计完成：清除内存中 in-flight（TTL 兜底在 hasInFlight）+ R5 持续交付 ----
	// 通过共享事件总线订阅 pi-subagents 的 async-complete 事件
	// R5 持续交付：审计者完成（async-complete）时若已写 blocked signature → 立即交付主 agent
	// （sendUserMessage followUp，不等下轮注入）——blocker 第一时间给主 agent 处理，直到没问题
	pi.events.on("subagent:async-complete", (data: unknown) => {
		const env = data as { asyncId?: string; runId?: string } | null;
		const completedId = env?.runId ?? env?.asyncId ?? "";
		let completedCwd: string | null = null;
		for (const [cwd, rec] of inFlightAudits) {
			if (completedId && rec.runId === completedId) {
				inFlightAudits.delete(cwd);
				completedCwd = cwd;
			}
		}
		// 持续交付：找到完成审计的 cwd → 若审计者已写 blocked → 立即交付主 agent
		if (completedCwd) {
			try {
				const st = readAuditState(completedCwd);
				if (
					st.signature?.status === "blocked" &&
					st.signature.blockers &&
					st.signature.blockers.length > 0
				) {
					pi.sendUserMessage(
						`结对审计发现缺口（请处理，处理后下轮自动再审）：\n${st.signature.blockers.map((b) => `- ${b}`).join("\n")}`,
						{ deliverAs: "followUp" },
					);
				}
			} catch {
				/* noop */
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
				if (text) appendConv(projectRoot(ctx.cwd), "user", text, RUN_ID);
				// 交付信号：用户明确要求交付（提交/发布/merge/交付/收工）→
				// ① 标记 agent_end 走同步门禁（等审计签名再放行）② 并行 fanout L2 深度审查
				// L2 前置门禁：无真实产物（无 git 改动且无决策）→ 不 spawn reviewer（杜绝空转）
				if (/提交|发布|merge|交付|收工|上线|部署|推送/.test(text)) {
					const root = projectRoot(ctx.cwd);
					deliveryRequested.add(root);
					const hasDeliverable =
						hasUncommittedChanges(root) ||
						entriesSinceLastAudit(root).length > 0;
					if (hasDeliverable) {
						void triggerDeliveryAudit(pi, rpc, readyPromise, root);
					}
				}
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content);
				if (text) {
					appendConv(projectRoot(ctx.cwd), "assistant", text, RUN_ID);
					// 意图信号记录（高信号过滤，≤200 字符；PI_PAIR_PROCESS_LOG=0 关闭——CI 跑分基线用）
					if (process.env.PI_PAIR_PROCESS_LOG !== "0") {
						appendProcessSignal(projectRoot(ctx.cwd), text, RUN_ID);
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
