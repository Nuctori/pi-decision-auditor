// SPDX-License-Identifier: MIT
// chain-store 单元测试：解析、编号、append-only、supersede、审计状态、convlog。
// 运行: node --import tsx --test test/chain-store.test.ts
// 或: npx tsx --test test/chain-store.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
	appendDecision,
	appendConv,
	appendProcessSignal,
	auditStatePath,
	chainPath,
	convLogLineCount,
	convlogForeignRuns,
	convlogPath,
	entriesSinceLastAudit,
	hasNewConversation,
	hasUncommittedChanges,
	listEntries,
	needsSignoff,
	parseChain,
	processPath,
	readAuditState,
	readConvTail,
	readProcess,
	readRaw,
	recordSignature,
	resetForSessionStart,
	resolveProjectRoot,
	writeAuditState,
} from "../lib/chain-store.js";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "chain-store-test-"));
}

test("appendDecision 自动编号与完整字段", () => {
	const dir = tmpDir();
	const e1 = appendDecision(dir, {
		summary: "采用 Redis 做读缓存",
		context: "QPS 峰值 2k；PG 读路径 60ms",
		decision: "引入 Redis 缓存读路径",
		rationale: "缓存命中 <5ms",
		alternatives: "Memcached（否决：功能少）",
		confidence: "high",
	});
	assert.equal(e1.id, "D-001");
	assert.equal(e1.status, "Accepted");
	assert.ok(e1.date.length > 0);

	const e2 = appendDecision(dir, {
		summary: "改用本地缓存",
		context: "单机部署",
		decision: "放弃 Redis",
		rationale: "无分布式需求",
		confidence: "low",
		supersedes: ["D-001"],
	});
	assert.equal(e2.id, "D-002");
	assert.deepEqual(e2.supersedes, ["D-001"]);

	// 文件存在且 append-only
	assert.ok(fs.existsSync(chainPath(dir)));
	const raw = readRaw(dir);
	assert.ok(raw.includes("D-001"));
	assert.ok(raw.includes("D-002"));
});

test("parseChain 解析全部字段与 supersede", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C1",
		decision: "D1",
		rationale: "R1",
		alternatives: "Alt1（否决：理由）",
		confidence: "medium",
	});
	appendDecision(dir, {
		summary: "B",
		context: "C2",
		decision: "D2",
		rationale: "R2",
		confidence: "low",
		supersedes: ["D-001"],
	});
	const entries = parseChain(readRaw(dir));
	assert.equal(entries.length, 2);
	assert.equal(entries[0].id, "D-001");
	assert.equal(entries[0].alternatives, "Alt1（否决：理由）");
	assert.equal(entries[0].confidence, "medium");
	assert.deepEqual(entries[1].supersedes, ["D-001"]);
	assert.equal(entries[1].confidence, "low");
});

test("append-only：旧条目不被修改", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	const before = readRaw(dir);
	appendDecision(dir, {
		summary: "B",
		context: "C2",
		decision: "D2",
		rationale: "R2",
	});
	const after = readRaw(dir);
	// 第一条的原文必须完整保留（append-only）
	assert.ok(after.includes(before.trim()));
});

test("listEntries onlyFrom 过滤", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	appendDecision(dir, {
		summary: "B",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	const entries = listEntries(dir, "D-002");
	assert.equal(entries.length, 1);
	assert.equal(entries[0].id, "D-002");
	// 不存在的 id → 空
	assert.equal(listEntries(dir, "D-999").length, 0);
});

test("审计状态读写与 entriesSinceLastAudit", () => {
	const dir = tmpDir();
	appendDecision(dir, {
		summary: "A",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	appendDecision(dir, {
		summary: "B",
		context: "C",
		decision: "D",
		rationale: "R",
	});
	appendDecision(dir, {
		summary: "C",
		context: "C",
		decision: "D",
		rationale: "R",
	});

	// 从未审计 → 全部
	assert.equal(entriesSinceLastAudit(dir).length, 3);

	// 审到 D-002 → 只返回 D-003
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditedId: "D-002",
		inFlight: false,
	});
	const fresh = entriesSinceLastAudit(dir);
	assert.equal(fresh.length, 1);
	assert.equal(fresh[0].id, "D-003");

	// 状态持久化
	const state = readAuditState(dir);
	assert.equal(state.lastAuditedId, "D-002");
	assert.equal(state.inFlight, false);
	assert.ok(fs.existsSync(auditStatePath(dir)));
});

test("convlog 追加与截断", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "请给 calc.py 加一个除法函数");
	appendConv(dir, "assistant", "已完成。");
	const tail = readConvTail(dir);
	assert.ok(tail.includes("用户"));
	assert.ok(tail.includes("除法函数"));
	assert.ok(fs.existsSync(convlogPath(dir)));

	// 超长截断
	const long = "x".repeat(2000);
	appendConv(dir, "user", long);
	const tail2 = readConvTail(dir);
	// 单条被截断到 maxLen，不会整段超长
	assert.ok(!tail2.includes(long));
});

test("convlog 多实例 runId 标记：按 run 隔离对话行", () => {
	const dir = tmpDir();
	// 实例 A（本会话）与实例 B（其他会话）并发写同一 convlog
	appendConv(dir, "user", "A 的决策请求", "run-a");
	appendConv(dir, "user", "B 的 ctx_knowledge 讨论", "run-b");
	appendConv(dir, "assistant", "A 的回复", "run-a");
	appendConv(dir, "assistant", "B 的回复", "run-b");

	const raw = fs.readFileSync(convlogPath(dir), "utf-8");
	const lines = raw.split(/\r?\n/);
	const aLines = lines.filter((l) => l.includes("<!--run:run-a-->"));
	const bLines = lines.filter((l) => l.includes("<!--run:run-b-->"));
	// 各自只有自己的行（无交叉、无混入）
	assert.equal(aLines.length, 2);
	assert.equal(bLines.length, 2);
	assert.ok(aLines.every((l) => !l.includes("ctx_knowledge")));
	assert.ok(bLines.every((l) => !l.includes("决策请求")));

	// 无 runId（旧格式/历史行）不产生标记
	appendConv(dir, "user", "旧格式行");
	const raw2 = fs.readFileSync(convlogPath(dir), "utf-8");
	assert.ok(!/旧格式行.*<!--run:/.test(raw2));

	// 对话行计数不受标记影响（带标记的行照常计入）
	assert.equal(convLogLineCount(dir), 5);
});

test("坏状态文件容错", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(auditStatePath(dir), "{corrupt json", "utf-8");
	const state = readAuditState(dir);
	assert.equal(state.lastAuditedId, null);
	assert.equal(state.inFlight, false);
	assert.equal(state.convExtractedLine, 0);
});

// L0 独立层已删除（单层审计）：accumulateRound/checkAuditDue 记账与节流测试随之移除——
// agent_end 按真实产物判定（hasUncommittedChanges or entriesSinceLastAudit）直接触发审计。

test("L0 记账字段已从状态移除（单层架构）", () => {
	const dir = tmpDir();
	const state = readAuditState(dir);
	assert.ok(!("roundsSinceAudit" in state), "roundsSinceAudit 字段必须移除");
	assert.ok(!("pendingChars" in state), "pendingChars 字段必须移除");
	assert.ok(!("chainFindings" in state), "chainFindings 字段必须移除");
	assert.ok(
		!("auditorRunId" in state),
		"auditorRunId 字段必须移除（fresh spawn）",
	);
});

test("auditFindings：读写与消毒（中间态交付）", () => {
	const dir = tmpDir();
	writeAuditState(dir, {
		...readAuditState(dir),
		auditFindings: ["推导目标 ✓", "已确认缺口：X"],
	});
	assert.deepEqual(readAuditState(dir).auditFindings, [
		"推导目标 ✓",
		"已确认缺口：X",
	]);
	// 坏值消毒
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(
		auditStatePath(dir),
		'{"auditFindings": ["ok", 42, null]}',
		"utf-8",
	);
	assert.deepEqual(readAuditState(dir).auditFindings, ["ok"]);
});

test("接线守卫：目标架构（单层审计 + fresh spawn + L2 门禁 + 价值点注入）", () => {
	const src = fs.readFileSync(
		path.join(process.cwd(), "extensions", "decision-chain.ts"),
		"utf-8",
	);
	// 单一权威 state：会话级根缓存 + 无裸 resolveProjectRoot(ctx.cwd)
	assert.ok(
		src.includes("const projectRoot = (cwd: string)"),
		"扩展必须定义会话级 projectRoot 缓存（单一权威 state）",
	);
	assert.ok(
		src.includes("cachedProjectRoot = null"),
		"session_start 必须重置根缓存（新会话重新解析）",
	);
	assert.ok(
		!src.includes("resolveProjectRoot(ctx.cwd)"),
		"handler 必须统一用 projectRoot（杜绝双 state 分裂）",
	);
	assert.ok(
		src.includes("PI_PAIR_PROJECT_ROOT"),
		"resolveProjectRoot 必须支持 PI_PAIR_PROJECT_ROOT 显式权威根（跨盘符兜底）",
	);
	// 单层审计：砍 L0 独立层（无 agent_settled 触发链、无 checkAuditDue、无 spawnL0Audit）
	assert.ok(
		!src.includes("spawnL0Audit") && !src.includes("checkAuditDue"),
		"必须砍 L0 独立层（单层审计：提取决策+审产物+签名一次完成）",
	);
	assert.ok(
		!src.includes("accumulateRound"),
		"必须砍 L0 记账（accumulateRound 已并入单层审计）",
	);
	assert.ok(
		!src.includes("chainFindings"),
		"必须砍 chainFindings 独立通道（单层审计直接签名）",
	);
	// fresh spawn：无常驻 run 复用（无 resume 生命周期、无 residentAuditorRunIds）
	assert.ok(
		!src.includes("residentAuditorRunIds") &&
			!src.includes("ensureAuditorInLane"),
		"必须砍常驻 run 生命周期（fresh spawn，审计完即死）",
	);
	// process 记录接线（意图信号，受 PI_PAIR_PROCESS_LOG 开关控制）
	assert.ok(
		src.includes("appendProcessSignal(projectRoot(ctx.cwd), text, RUN_ID)"),
		"message_end 必须调 appendProcessSignal 记意图信号（带 runId 隔离）",
	);
	assert.ok(
		src.includes('process.env.PI_PAIR_PROCESS_LOG !== "0"'),
		"process 记录必须受 PI_PAIR_PROCESS_LOG 开关控制（CI 跑分基线）",
	);
	// 审计任务必须引导读过程日志
	assert.ok(src.includes("processPath(cwd)"), "审计任务必须引用过程日志路径");
	// 实证盲区维度（prompt 优化）：机制完整性 + 运行时行为
	assert.ok(
		src.includes("机制完整性"),
		"审计任务必须含机制完整性检查（防断线回归）",
	);
	assert.ok(
		src.includes("运行时行为"),
		"审计任务必须含运行时行为检查（防 print/交互模式盲区）",
	);
	// 路径提示：链位置以实际文件为准
	assert.ok(
		src.includes("链的实际位置以 find 到的真实文件为准"),
		"审计任务路径提示必须引导 find 真实链（防 cwd 解析误导）",
	);
	// 会话隔离接线：写入点传 RUN_ID、prompt 注入过滤规则、多实例检测接通
	assert.ok(
		src.includes('appendConv(projectRoot(ctx.cwd), "user", text, RUN_ID)'),
		"message_end 用户行必须带 RUN_ID 标记（会话隔离）",
	);
	assert.ok(
		src.includes('appendConv(projectRoot(ctx.cwd), "assistant", text, RUN_ID)'),
		"message_end 助手行必须带 RUN_ID 标记（会话隔离）",
	);
	assert.ok(
		src.includes("appendProcessSignal(projectRoot(ctx.cwd), text, RUN_ID)"),
		"process.md 意图信号必须带 RUN_ID 标记（隔离）",
	);
	const ruleCount = src.split("<!--run:${RUN_ID}-->").length - 1;
	assert.ok(
		ruleCount >= 4,
		`4 处审计/L2 prompt 必须注入会话隔离规则（防重构删掉），实际 ${ruleCount} 处`,
	);
	assert.ok(
		src.includes("convlogForeignRuns(root, RUN_ID) > 0"),
		"agent_end 必须做多实例混写检测（跳过错审）",
	);
	// 工作判据（便宜信号）+ 审计者 AI 判定（第零步）
	assert.ok(
		src.includes("hasUncommittedChanges(root)") &&
			src.includes("hasNewConversation(root, state.convExtractedLine"),
		"agent_end 用两个便宜信号触发：git 产物 or 对话增量（语义判断交给审计者，不做正则信号词判定）",
	);
	assert.ok(
		src.includes("第零步：判定本轮是否有值得审计的工作"),
		"审计任务必须先 AI 判定本轮有无工作（纯咨询快速退出零注入；plan 阶段提取决策+审决策）",
	);
	assert.ok(
		src.includes("本轮纯咨询，无审计对象"),
		"纯咨询快速退出路径必须存在（推进游标、零价值点注入）",
	);
	assert.ok(
		src.includes("deliveryRequested"),
		"交付信号必须在 message_end 登记（提交/发布/merge → agent_end 同步门禁）",
	);
	assert.ok(
		src.includes("if (!isDelivery) return;"),
		"常规轮必须异步（agent_end 不阻塞等签名）——findings 下轮注入",
	);
	// L2 交付审查必须有真实产物门禁（无 git diff 且无决策 → 不 spawn，杜绝空转）
	assert.ok(
		src.includes("hasUncommittedChanges") &&
			src.includes("triggerDeliveryAudit"),
		"L2 交付审查必须带真实产物门禁（无交付物不 spawn，杜绝 follow_me 空转）",
	);
	// 价值点可观察 / 流程隐藏
	assert.ok(
		src.includes("display: true"),
		"审计价值点（blockers/auditFindings）必须 display:true 注入——用户可观察（状态机 T4）",
	);
	assert.ok(
		!src.includes("negotiateStop"),
		"600s 协商黑洞必须移除（超时直接降级放行 + findings 下轮注入）",
	);
	assert.ok(
		!src.includes("审计未通过（第"),
		"blocked 计数刷屏必须移除（不再 sendUserMessage 给用户）",
	);
	// session_shutdown 清理（fresh spawn 场景：清内存锁即可，无常驻 run 残留）
	assert.ok(
		src.includes('pi.on("session_shutdown"'),
		"session_shutdown handler 必须存在（清理内存锁）",
	);
	// 持续交付：审计完成（async-complete）时若有 blockers → 立即交付主 agent 处理
	assert.ok(
		src.includes("subagent:async-complete") &&
			src.includes("blockers") &&
			src.includes("sendUserMessage"),
		"审计完成事件必须把 blockers 立即交付主 agent（持续交付，不等下轮）",
	);
	// H2：waitForAuditCompletion 完成判定 = 本轮新签名（blocked 也算完成，防覆盖真实 blockers）
	assert.ok(
		src.includes("state.signature.at >= startedAt"),
		"完成判定必须用 signature.at >= auditStartedAt（blocked 签名不推进 convLine 但仍是本轮结论）",
	);
	// M2：交付标记先消费（无泄漏到下轮）
	assert.ok(
		src.includes("deliveryRequested.delete(root)") &&
			src.includes("const isDelivery = deliveryRequested.has(root)") &&
			src.indexOf("const isDelivery") <
				src.indexOf("hasUncommittedChanges(root)"),
		"deliveryRequested 必须在 agent_end 最前消费（任何早退路径都不泄漏）",
	);
	// M4：残留锁兜底（文件锁在但内存锁无 → 释放，防审计永久停摆）
	assert.ok(
		src.includes("state.inFlight && !hasInFlight(root)"),
		"agent_end 必须有残留锁兜底（审计者被强杀未写收尾时释放文件锁）",
	);
	// 完成即停：审计者 prompt 必须含明确停止边界
	assert.ok(
		src.includes("完成即停") && src.includes("签名后的一切继续都是浪费"),
		"审计者 prompt 必须含完成即停边界（签名后不再扩大范围）",
	);
});

test("appendProcessSignal：信号词命中才记录", () => {
	const dir = tmpDir();
	// 命中：含决策信号词
	assert.equal(appendProcessSignal(dir, "我决定采用 Redis 做读缓存"), true);
	assert.equal(appendProcessSignal(dir, "方案是引入本地缓存"), true);
	// 未命中：普通陈述
	assert.equal(appendProcessSignal(dir, "我读完了文件，继续下一步"), false);

	const proc = readProcess(dir);
	assert.ok(proc.includes("决定采用 Redis"), "命中信号词必须记录");
	assert.ok(proc.includes("方案是引入本地缓存"));
	assert.ok(!proc.includes("读完了文件"), "未命中不得记录");
	// process.md 文件确实存在
	assert.ok(fs.existsSync(processPath(dir)));
});

test("appendProcessSignal：200 字符截断", () => {
	const dir = tmpDir();
	const long = "我决定采用方案：" + "很长的内容".repeat(60); // > 200 字符
	appendProcessSignal(dir, long);
	const proc = readProcess(dir);
	const line = proc.split("\n").find((l) => l.startsWith("- 🤔")) ?? "";
	assert.ok(line.length <= 210, `单条应 ≤200 字符+后缀，实际 ${line.length}`);
	assert.ok(line.endsWith("…"), "超长应截断并加省略号");
});

test("appendProcessSignal：滚动截断（超 100 条保留最近 50）", () => {
	const dir = tmpDir();
	for (let i = 0; i < 110; i++) {
		appendProcessSignal(dir, `我决定第 ${i} 个方案`);
	}
	const raw = fs.readFileSync(processPath(dir), "utf-8");
	const body = raw.split("\n").filter((l) => l.startsWith("- 🤔"));
	assert.ok(body.length <= 100, `滚动截断后应 ≤100 条，实际 ${body.length}`);
	// 保留的是最近条目（第 101 次触发截断删掉最早的）
	assert.ok(raw.includes("第 109 个方案"));
	assert.ok(!raw.includes("第 0 个方案"), "最早的应被截断");
});

test("appendProcessSignal：runId 标记隔离", () => {
	const dir = tmpDir();
	appendProcessSignal(dir, "我决定采用方案 X", "run-a");
	const raw = fs.readFileSync(processPath(dir), "utf-8");
	assert.ok(raw.includes("<!--run:run-a-->"), "带 runId 的行必须标记");
	// 无 runId（旧格式）不产生标记
	appendProcessSignal(dir, "我决定采用方案 Y");
	const raw2 = fs.readFileSync(processPath(dir), "utf-8");
	assert.ok(!/方案 Y.*<!--run:/.test(raw2), "无 runId 调用不得标记");
});

test("convlogForeignRuns：多实例混写检测", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "本实例用户请求", "run-a");
	appendConv(dir, "assistant", "本实例回复", "run-a");
	appendConv(dir, "user", "其他实例的 ctx_knowledge 讨论", "run-b");
	appendConv(dir, "user", "旧代码无标记行", undefined);

	// 本实例视角：run-b 是外来真实用户行 → 检测到多实例
	assert.equal(convlogForeignRuns(dir, "run-a"), 1);
	// 反向视角：run-a 对 run-b 同样是外来
	assert.equal(convlogForeignRuns(dir, "run-b"), 1);
	// 无标记行（历史无法归属）不误报
	const dirLegacy = tmpDir();
	appendConv(dirLegacy, "user", "旧代码无标记行", undefined);
	assert.equal(convlogForeignRuns(dirLegacy, "run-x"), 0);
	// 审计任务注入（Task: 前缀）不算外来会话
	const dirTask = tmpDir();
	appendConv(dirTask, "user", "Task: 你是链维护审计者…", "run-c");
	assert.equal(convlogForeignRuns(dirTask, "run-x"), 0);
	// 用户正文内嵌伪造标记（非行尾）不算外来——防伪造 run 标记关闭审计门禁
	const dirSpoof = tmpDir();
	appendConv(
		dirSpoof,
		"user",
		"请修复这个 bug <!--run:run-999-zzz-->",
		"run-a",
	);
	assert.equal(convlogForeignRuns(dirSpoof, "run-a"), 0);
	// 真实行尾标记（其他实例）仍必须检出
	const dirReal = tmpDir();
	appendConv(dirReal, "user", "其他实例的 ctx_knowledge 讨论", "run-b");
	assert.equal(convlogForeignRuns(dirReal, "run-a"), 1);
	// 纯单实例：无外来行
	const dir2 = tmpDir();
	appendConv(dir2, "user", "只有本实例", "run-a");
	assert.equal(convlogForeignRuns(dir2, "run-a"), 0);
});

test("lastAuditDurationMs：读写与消毒", () => {
	const dir = tmpDir();
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditDurationMs: 12345,
	});
	assert.equal(readAuditState(dir).lastAuditDurationMs, 12345);
	// 坏值消毒
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(
		auditStatePath(dir),
		'{"lastAuditDurationMs": "bad"}',
		"utf-8",
	);
	assert.equal(readAuditState(dir).lastAuditDurationMs, 0);
});

test("recordSignature 字段级写入", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");
	recordSignature(dir, { status: "passed" });
	const s1 = readAuditState(dir);
	assert.equal(s1.signature?.status, "passed");
	assert.ok(s1.signatureConvLine > 0);
	assert.equal(needsSignoff(dir), false);

	// blocked 签名
	recordSignature(dir, { status: "blocked", blockers: ["x"] });
	const s2 = readAuditState(dir);
	assert.equal(s2.signature?.status, "blocked");
	assert.deepEqual(s2.signature?.blockers, ["x"]);
});

test("blockedStreak：blocked 递增，passed/降级清零（timeout 态已移除）", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");

	// 初始 0
	assert.equal(readAuditState(dir).blockedStreak, 0);

	// blocked 递增 1
	recordSignature(dir, { status: "blocked", blockers: ["a"] });
	assert.equal(readAuditState(dir).blockedStreak, 1);

	// blocked 递增 2（连续）
	recordSignature(dir, { status: "blocked", blockers: ["b"] });
	assert.equal(readAuditState(dir).blockedStreak, 2);

	// passed 清零
	recordSignature(dir, { status: "passed" });
	assert.equal(readAuditState(dir).blockedStreak, 0);

	// 降级放行（passed-with-warning）也清零
	recordSignature(dir, { status: "blocked", blockers: ["c"] });
	assert.equal(readAuditState(dir).blockedStreak, 1);
	recordSignature(dir, {
		status: "passed-with-warning",
		blockers: ["c"],
	});
	assert.equal(readAuditState(dir).blockedStreak, 0);
	assert.equal(readAuditState(dir).signature?.status, "passed-with-warning");
});

test("recordSignature 释放 inFlight 锁（H1：防锁泄漏致审计永久停摆）", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");
	// 模拟审计运行中（inFlight=true）→ 审计者用 decision_signoff 签名
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: true,
	});
	recordSignature(dir, { status: "blocked", blockers: ["x"] });
	// 签名 = 审计结束：锁必须释放（否则后续 agent_end 永不 spawn 审计者）
	assert.equal(readAuditState(dir).inFlight, false);
	// blocked 签名同时递增 streak
	assert.equal(readAuditState(dir).blockedStreak, 1);
});

test("readAuditState 坏 signature 消毒", () => {
	const dir = tmpDir();
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(
		auditStatePath(dir),
		'{"signature": "passed-string"}',
		"utf-8",
	);
	const state = readAuditState(dir);
	assert.equal(state.signature, null); // 非对象 → 消毒为 null
});

// resolveAuditConfig 已随 L0 独立层删除（单层审计无需累积阈值配置）

test("resetForSessionStart 清跨会话待签名状态", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "上一会话的工作");
	appendConv(dir, "assistant", "做了改动但没签名");
	// 模拟旧会话：有对话但 signatureConvLine=0 → needsSignoff=true
	assert.equal(needsSignoff(dir), true);

	// 新会话开始：重置
	resetForSessionStart(dir);
	assert.equal(needsSignoff(dir), false); // 不再触发待签名

	// 决策链进度保留
	const state = readAuditState(dir);
	assert.equal(state.inFlight, false);
	// signatureConvLine 推进到当前 convlog 行数
	assert.ok(state.signatureConvLine >= convLogLineCount(dir) - 0);
});

test("needsSignoff 与 recordSignature 状态机", () => {
	const dir = tmpDir();
	// 无对话 → 不需要签名
	assert.equal(needsSignoff(dir), false);

	// 有对话 → 需要签名
	appendConv(dir, "user", "请加一个函数");
	assert.equal(needsSignoff(dir), true);

	// 签名后 → 不再需要
	recordSignature(dir, { status: "passed" });
	assert.equal(needsSignoff(dir), false);

	// 新对话 → 又需要
	appendConv(dir, "assistant", "已完成");
	assert.equal(needsSignoff(dir), true);

	// blocked 签名也解除待签名（记录问题由注入处理）
	recordSignature(dir, { status: "blocked", blockers: ["产物不忠实"] });
	const state = readAuditState(dir);
	assert.equal(state.signature?.status, "blocked");
	assert.equal(state.signature?.blockers?.length, 1);
	assert.equal(needsSignoff(dir), false);
});

test("resolveProjectRoot 定位仓库根", () => {
	const root = tmpDir();
	// 子目录无标记 → 向上找
	const sub = path.join(root, "src");
	fs.mkdirSync(sub, { recursive: true });
	// 无标记时退化到 cwd
	assert.equal(resolveProjectRoot(sub), sub);

	// 放 Cargo.toml 标记
	fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]\n", "utf-8");
	assert.equal(resolveProjectRoot(sub), root); // 向上找到根
	assert.equal(resolveProjectRoot(root), root); // 根本身

	// package.json 标记
	const node = path.join(root, "node");
	fs.mkdirSync(node, { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), "{}", "utf-8");
	assert.equal(resolveProjectRoot(node), root);
});

test("resolveProjectRoot：PI_PAIR_PROJECT_ROOT 显式权威根（跨盘符兜底）", () => {
	const dir = tmpDir();
	const explicit = path.join(dir, "real-root");
	fs.mkdirSync(explicit, { recursive: true });
	const prev = process.env.PI_PAIR_PROJECT_ROOT;
	try {
		process.env.PI_PAIR_PROJECT_ROOT = explicit;
		// 任意 cwd 都解析到显式根（跨盘符/复杂场景的单一权威）
		assert.equal(resolveProjectRoot(dir), explicit);
		assert.equal(
			resolveProjectRoot(path.join(dir, "deep", "nested")),
			explicit,
		);
	} finally {
		if (prev === undefined) delete process.env.PI_PAIR_PROJECT_ROOT;
		else process.env.PI_PAIR_PROJECT_ROOT = prev;
	}
	// 未设置时恢复正常探测
	assert.equal(resolveProjectRoot(dir), dir);
});

test("convLogLineCount 统计对话行", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "你好");
	appendConv(dir, "assistant", "收到");
	assert.equal(convLogLineCount(dir), 2);
});

test("hasUncommittedChanges：真实产物判定（git 未提交改动）", () => {
	// 非 git 仓库（tmp 目录）→ false（无代码产物可审；决策条目由 entriesSinceLastAudit 兜底）
	const dir = tmpDir();
	assert.equal(hasUncommittedChanges(dir), false);

	// git 仓库且干净 → false
	const gitDir = tmpDir();
	const run = (args: string[]) =>
		execFileSync("git", args, {
			cwd: gitDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
	run(["init", "-q"]);
	run(["config", "user.email", "t@t"]);
	run(["config", "user.name", "t"]);
	fs.writeFileSync(path.join(gitDir, "a.txt"), "v1", "utf-8");
	run(["add", "."]);
	run(["commit", "-qm", "init"]);
	assert.equal(hasUncommittedChanges(gitDir), false);

	// 未提交改动 → true
	fs.writeFileSync(path.join(gitDir, "a.txt"), "v2", "utf-8");
	assert.equal(hasUncommittedChanges(gitDir), true);

	// 未跟踪新文件 → true（--untracked-files=all）
	fs.writeFileSync(path.join(gitDir, "new.txt"), "x", "utf-8");
	assert.equal(hasUncommittedChanges(gitDir), true);

	// R11：扩展自身状态目录（.pi/ .pi-subagents/）不算产物——审计状态/convlog 写入不触发审计
	// 先让工作树干净（提交 a.txt v2，删除 new.txt 也提交），只剩 .pi 未跟踪
	run(["add", "-A"]);
	run(["commit", "-qm", "v2"]);
	fs.unlinkSync(path.join(gitDir, "new.txt"));
	run(["add", "-A"]);
	run(["commit", "-qm", "drop new"]);
	fs.mkdirSync(path.join(gitDir, ".pi", "decision-auditor"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(gitDir, ".pi", "decision-auditor", "state.json"),
		"{}",
		"utf-8",
	);
	fs.mkdirSync(path.join(gitDir, ".pi-subagents", "artifacts"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(gitDir, ".pi-subagents", "artifacts", "x.md"),
		"x",
		"utf-8",
	);
	assert.equal(
		hasUncommittedChanges(gitDir),
		false,
		".pi/.pi-subagents 写入不得算产物（纯咨询会话仍零审计）",
	);
	// 真实改动 + 状态目录并存 → 仍 true
	fs.writeFileSync(path.join(gitDir, "a.txt"), "v3", "utf-8");
	assert.equal(hasUncommittedChanges(gitDir), true);
});

test("hasNewConversation：对话增量判据（plan 阶段触发审计）", () => {
	const dir = tmpDir();
	// 无对话 → 无增量（不触发）
	assert.equal(hasNewConversation(dir, 0), false);
	// 有对话 → 增量（触发：spawn 审计者由它 AI 判定）
	appendConv(dir, "user", "我们采用方案 B 吧，放弃 A");
	assert.equal(hasNewConversation(dir, 0), true);
	// 审计者推进游标后 → 该段对话不再触发
	assert.equal(hasNewConversation(dir, 1), false);
	// 新对话 → 再次触发
	appendConv(dir, "assistant", "好，按方案 B 实现");
	assert.equal(hasNewConversation(dir, 1), true);
});
