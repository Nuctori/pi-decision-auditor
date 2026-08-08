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
	appendDecision,
	appendConv,
	auditStatePath,
	chainPath,
	convlogPath,
	entriesSinceLastAudit,
	listEntries,
	parseChain,
	readAuditState,
	readConvTail,
	readRaw,
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
	writeAuditState(dir, { lastAuditedId: "D-002", inFlight: false });
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
});
