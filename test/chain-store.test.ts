// SPDX-License-Identifier: MIT
// chain-store 单元测试：解析、编号、append-only、supersede、审计状态、convlog。
// 运行: node --import tsx --test test/chain-store.test.ts
// 或: npx tsx --test test/chain-store.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	accumulateRound,
	appendDecision,
	appendConv,
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
	readConvTail,
	readProcess,
	readRaw,
	recordSignature,
	resetForSessionStart,
	resolveAuditConfig,
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
	assert.equal(state.roundsSinceAudit, 0);
});

test("L0 记账+判断：batchRounds 触发", () => {
	const dir = tmpDir();
	// 记账（message_end 每轮调 accumulateRound）→ 判断（agent_settled 调 checkAuditDue）
	for (let i = 0; i < 5; i++) {
		accumulateRound(dir, 100);
		assert.equal(checkAuditDue(dir), false); // rounds 1..5 < batchRounds(6)
	}
	accumulateRound(dir, 100); // 第 6 轮
	assert.equal(checkAuditDue(dir), true); // rounds=6 → 触发

	// 触发后清零：下一轮重新累积
	accumulateRound(dir, 100);
	const state = readAuditState(dir);
	assert.equal(state.roundsSinceAudit, 1);
	assert.equal(state.pendingChars, 100);
});

test("L0 记账+判断：batchChars 触发", () => {
	const dir = tmpDir();
	// 每轮 2000 字符，默认 batchChars=8000 → 第 4 轮触发
	for (let i = 0; i < 3; i++) {
		accumulateRound(dir, 2000);
		assert.equal(checkAuditDue(dir), false);
	}
	accumulateRound(dir, 2000); // 累积 8000
	assert.equal(checkAuditDue(dir), true);
});

test("L0：inFlight（L1 门禁在跑）时不唤起", () => {
	const dir = tmpDir();
	accumulateRound(dir, 5000);
	writeAuditState(dir, { ...readAuditState(dir), inFlight: true });
	assert.equal(checkAuditDue(dir), false); // L1 在跑 → L0 不抢
});

test("L0：force 跳过 minInterval（decision_add 路径）", () => {
	const dir = tmpDir();
	// 先完成一次审计（设 lastAuditAt），再验证 force 行为
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditAt: Date.now(),
		roundsSinceAudit: 0,
	});
	// 非 force：距上次审计 0 轮 < minInterval(2) → 不触发
	assert.equal(checkAuditDue(dir), false);
	// force：跳过 minInterval，直接触发
	assert.equal(checkAuditDue(dir, true), true);
});

test("L0：minInterval 节流（距上次审计不足）", () => {
	const dir = tmpDir();
	// 上次审计刚发生（lastAuditAt 现在），记账 1 轮
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditAt: Date.now(),
	});
	accumulateRound(dir, 100);
	assert.equal(checkAuditDue(dir), false); // rounds=1 < minInterval(2)
	accumulateRound(dir, 100);
	assert.equal(checkAuditDue(dir), false); // rounds=2 >= minInterval 但 < batchRounds
});

test("L1 收尾不清 L0 记账（分层隔离）", () => {
	const dir = tmpDir();
	// L0 记账两轮
	accumulateRound(dir, 100);
	accumulateRound(dir, 100);
	const before = readAuditState(dir);
	assert.equal(before.roundsSinceAudit, 2);

	// 模拟 L1 门禁收尾：只写签名/inFlight/lastAuditAt，不碰 roundsSinceAudit/pendingChars
	writeAuditState(dir, {
		...readAuditState(dir),
		inFlight: false,
		lastAuditAt: Date.now(),
		signature: { status: "passed", at: Date.now() },
	});

	const after = readAuditState(dir);
	assert.equal(after.roundsSinceAudit, 2); // L1 收尾不清记账 → L0 累积保留
	assert.equal(after.pendingChars, 200);
	// 下一轮继续记账 → 仍能攒够触发
	accumulateRound(dir, 100);
	assert.equal(readAuditState(dir).roundsSinceAudit, 3);
});

test("chainFindings：读写与消毒", () => {
	const dir = tmpDir();
	writeAuditState(dir, {
		...readAuditState(dir),
		chainFindings: ["D-001 与 D-002 矛盾"],
	});
	assert.deepEqual(readAuditState(dir).chainFindings, ["D-001 与 D-002 矛盾"]);
	// 坏值消毒
	fs.mkdirSync(path.dirname(auditStatePath(dir)), { recursive: true });
	fs.writeFileSync(
		auditStatePath(dir),
		'{"chainFindings": ["ok", 42, null]}',
		"utf-8",
	);
	assert.deepEqual(readAuditState(dir).chainFindings, ["ok"]);
});

test("接线守卫：L0 触发链在扩展里接通（防断线回归）", () => {
	const src = fs.readFileSync(
		path.join(process.cwd(), "extensions", "decision-chain.ts"),
		"utf-8",
	);
	// message_end 记账（单一权威根：projectRoot 缓存）
	assert.ok(
		src.includes("accumulateRound(projectRoot(ctx.cwd), text.length)"),
		"message_end 必须调 accumulateRound 记账（用 projectRoot）",
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
	// agent_settled 判断+唤起
	assert.ok(
		src.includes('pi.on("agent_settled"'),
		"agent_settled handler 必须存在",
	);
	assert.ok(
		src.includes("checkAuditDue(root)"),
		"agent_settled 必须调 checkAuditDue",
	);
	assert.ok(
		src.includes("spawnL0Audit(pi, rpc, readyPromise, root)"),
		"agent_settled 必须 spawn L0",
	);
	// L0 复用 L1 常驻 run（一个持灯人，不新增实例）
	assert.ok(
		src.includes("state.auditorRunId") && src.includes('"resume"'),
		"spawnL0Audit 必须 resume 常驻审计者 run（L0/L1 同一实例）",
	);
	// L1 任务不碰记账字段
	assert.ok(
		src.includes("不要清 roundsSinceAudit/pendingChars"),
		"L1 收尾不得清 L0 记账",
	);
	// decision_add 走 L0
	assert.ok(
		src.includes("checkAuditDue(projectRoot(ctx.cwd), true)"),
		"decision_add 必须 force 触发 L0",
	);
	// process 记录接线（意图信号，受 PI_PAIR_PROCESS_LOG 开关控制）
	assert.ok(
		src.includes("appendProcessSignal(projectRoot(ctx.cwd), text)"),
		"message_end 必须调 appendProcessSignal 记意图信号",
	);
	assert.ok(
		src.includes('process.env.PI_PAIR_PROCESS_LOG !== "0"'),
		"process 记录必须受 PI_PAIR_PROCESS_LOG 开关控制（CI 跑分基线）",
	);
	// L1 审计任务必须引导读过程日志
	assert.ok(src.includes("processPath(cwd)"), "审计任务必须引用过程日志路径");
	// 审计阻塞时长测量
	assert.ok(
		src.includes("lastAuditDurationMs"),
		"agent_end 必须记录审计阻塞时长（CI 跑分指标）",
	);
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

test("blockedStreak：blocked/timeout 递增，passed/降级清零", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "测试");

	// 初始 0
	assert.equal(readAuditState(dir).blockedStreak, 0);

	// blocked 递增 1
	recordSignature(dir, { status: "blocked", blockers: ["a"] });
	assert.equal(readAuditState(dir).blockedStreak, 1);

	// timeout 递增 2
	recordSignature(dir, { status: "timeout" });
	assert.equal(readAuditState(dir).blockedStreak, 2);

	// blocked 递增 3
	recordSignature(dir, { status: "blocked", blockers: ["b"] });
	assert.equal(readAuditState(dir).blockedStreak, 3);

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

test("resolveAuditConfig 环境变量覆盖", () => {
	const cfg = resolveAuditConfig({
		PI_PAIR_BATCH_ROUNDS: "3",
		PI_PAIR_BATCH_CHARS: "5000",
		PI_PAIR_MIN_INTERVAL: "1",
		PI_PAIR_MAX_BATCH: "10",
	} as Record<string, string>);
	assert.equal(cfg.batchRounds, 3);
	assert.equal(cfg.batchChars, 5000);
	assert.equal(cfg.minIntervalRounds, 1);
	assert.equal(cfg.maxBatchRounds, 10);
});

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
	assert.equal(state.roundsSinceAudit, 0);
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
