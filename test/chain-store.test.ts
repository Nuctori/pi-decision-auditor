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
	accumulatePending,
	appendDecision,
	appendConv,
	auditStatePath,
	chainPath,
	convLogLineCount,
	convlogPath,
	entriesSinceLastAudit,
	listEntries,
	needsSignoff,
	parseChain,
	readAuditState,
	readConvTail,
	readRaw,
	recordSignature,
	resetForSessionStart,
	resolveAuditConfig,
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

test("accumulatePending：batchRounds 触发", () => {
	const dir = tmpDir();
	// 第一次调用（lastAuditAt=0）也应触发（首次尽快审）
	// 但默认 batchRounds=6：前 5 次只记账，第 6 次触发
	const results: boolean[] = [];
	for (let i = 0; i < 5; i++) results.push(accumulatePending(dir, 100));
	assert.deepEqual(results, [false, false, false, false, false]);
	assert.equal(accumulatePending(dir, 100), true); // 第 6 轮触发

	// 触发后清零：下一轮重新累积
	assert.equal(accumulatePending(dir, 100), false);
	const state = readAuditState(dir);
	assert.equal(state.roundsSinceAudit, 1);
	assert.equal(state.pendingChars, 100);
});

test("accumulatePending：batchChars 触发", () => {
	const dir = tmpDir();
	// 每轮 2000 字符，默认 batchChars=8000 → 第 4 轮触发
	const results: boolean[] = [];
	for (let i = 0; i < 3; i++) results.push(accumulatePending(dir, 2000));
	assert.deepEqual(results, [false, false, false]);
	assert.equal(accumulatePending(dir, 2000), true); // 累积 8000 → 触发
});

test("accumulatePending：inFlight 不累积", () => {
	const dir = tmpDir();
	writeAuditState(dir, { ...readAuditState(dir), inFlight: true });
	assert.equal(accumulatePending(dir, 5000), false);
	// inFlight 期间不累积
	const state = readAuditState(dir);
	assert.equal(state.pendingChars, 0);
});

test("accumulatePending：force 跳过 minInterval", () => {
	const dir = tmpDir();
	// 先完成一次审计（设 lastAuditAt），再验证 force 行为
	writeAuditState(dir, {
		...readAuditState(dir),
		lastAuditAt: Date.now(),
		roundsSinceAudit: 0,
	});
	// 非 force：距上次审计 1 轮 < minInterval(2) → 不触发
	assert.equal(accumulatePending(dir, 100), false);
	// force：跳过 minInterval，直接触发
	assert.equal(accumulatePending(dir, 100, true), true);
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

test("convLogLineCount 统计对话行", () => {
	const dir = tmpDir();
	appendConv(dir, "user", "你好");
	appendConv(dir, "assistant", "收到");
	assert.equal(convLogLineCount(dir), 2);
});
