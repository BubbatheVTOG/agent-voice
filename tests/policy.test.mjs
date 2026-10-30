import assert from "node:assert/strict";
import test from "node:test";
import { registerAutoAnnounce } from "../extension/policy.ts";

const ARMED = {
	enabled: true,
	autoAnnounce: true,
	envKill: false,
	announceOn: ["needs-input", "failure", "stopped", "long-completion"],
	longJobThresholdSec: 120,
};

const ctx = { cwd: "/tmp", isProjectTrusted: () => true };

function harness(t, config = ARMED) {
	t.mock.timers.enable({ apis: ["Date"], now: 0 });
	const handlers = new Map();
	const sent = [];
	const pi = {
		on: (name, fn) => {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		sendMessage: (message, options) => sent.push({ message, options }),
	};
	const auto = registerAutoAnnounce(pi, () => config);
	const emit = (name, event) => {
		for (const fn of handlers.get(name) ?? []) fn(event, ctx);
	};
	return { sent, emit, reset: () => auto.reset() };
}

const startTask = (callId, taskId, status) => ({
	toolName: "TaskUpdate",
	toolCallId: callId,
	args: { taskId, status },
});

test("task bookkeeping ticks never nudge", (t) => {
	const { sent, emit } = harness(t);
	for (const id of ["1", "2", "3", "4"]) {
		emit("tool_execution_start", startTask(`call-${id}`, id, "in_progress"));
		emit("tool_execution_start", startTask(`done-${id}`, id, "completed"));
		emit("tool_execution_end", { toolName: "TaskUpdate", toolCallId: `done-${id}`, isError: false });
	}
	assert.equal(sent.length, 0, "a status tick carries no duration evidence");
});

test("a task that ran past the threshold nudges once", (t) => {
	const { sent, emit } = harness(t);
	emit("tool_execution_start", startTask("start-1", "1", "in_progress"));
	t.mock.timers.tick(130_000);
	emit("tool_execution_start", startTask("done-1", "1", "completed"));
	emit("tool_execution_end", { toolName: "TaskUpdate", toolCallId: "done-1", isError: false });
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /"long-completion"/);
	assert.equal(sent[0].message.display, false);
});

test("a task shorter than the threshold stays silent", (t) => {
	const { sent, emit } = harness(t);
	emit("tool_execution_start", startTask("start-1", "1", "in_progress"));
	t.mock.timers.tick(5_000);
	emit("tool_execution_start", startTask("done-1", "1", "completed"));
	emit("tool_execution_end", { toolName: "TaskUpdate", toolCallId: "done-1", isError: false });
	assert.equal(sent.length, 0);
});

test("a task re-opened later is measured from its latest start", (t) => {
	const { sent, emit } = harness(t);
	emit("tool_execution_start", startTask("start-1", "1", "in_progress"));
	t.mock.timers.tick(600_000);
	emit("tool_execution_start", startTask("start-2", "1", "in_progress"));
	t.mock.timers.tick(1_000);
	emit("tool_execution_start", startTask("done-1", "1", "completed"));
	emit("tool_execution_end", { toolName: "TaskUpdate", toolCallId: "done-1", isError: false });
	assert.equal(sent.length, 0);
});

test("a burst of completions collapses into one nudge", (t) => {
	const { sent, emit } = harness(t);
	const completion = (id) => ({
		message: {
			role: "user",
			id,
			content: "Background task completed: **worker** (all green)",
		},
	});
	emit("message_end", completion("msg-1"));
	emit("message_end", completion("msg-2"));
	emit("message_end", completion("msg-3"));
	assert.equal(sent.length, 1, "one announcement covers a burst");
});

test("a completion later in the session nudges again", (t) => {
	const { sent, emit } = harness(t);
	const completion = (id) => ({
		message: {
			role: "user",
			id,
			content: "Background task completed: **worker**",
		},
	});
	emit("message_end", completion("msg-1"));
	t.mock.timers.tick(60_000);
	emit("message_end", completion("msg-2"));
	assert.equal(sent.length, 2);
});

test("the same notification nudges once", (t) => {
	const { sent, emit } = harness(t);
	const event = {
		message: {
			role: "user",
			id: "msg-1",
			content: "Background task completed: **worker**",
		},
	};
	emit("message_end", event);
	t.mock.timers.tick(60_000);
	emit("message_end", event);
	assert.equal(sent.length, 1);
});

test("a disabled voice never nudges", (t) => {
	const { sent, emit } = harness(t, { ...ARMED, enabled: false, autoAnnounce: false });
	emit("message_end", {
		message: {
			role: "user",
			id: "msg-1",
			content: "Background task completed: **worker**",
		},
	});
	assert.equal(sent.length, 0);
});

// ── structured notice decisions (details.runs) ──────────────────────────────

const notice = (id, head, runs) => ({
	message: {
		role: "custom",
		customType: "subagent-notify",
		id,
		content: head,
		details: runs === undefined ? undefined : { runs },
	},
});

test("a completed run past the threshold announces with its duration", (t) => {
	const { sent, emit } = harness(t);
	emit("message_end", notice("m1", "Background task completed: **worker**", [
		{ agent: "worker", status: "completed", durationMs: 234_862 },
	]));
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /3m54s/);
	assert.match(sent[0].message.content, /announce it/i);
});

test("a completed run below the threshold stays silent", (t) => {
	const { sent, emit } = harness(t);
	emit("message_end", notice("m1", "Background task completed: **worker**", [
		{ agent: "worker", status: "completed", durationMs: 1_154 },
	]));
	assert.equal(sent.length, 0);
});

test("a completion without a duration stays a model-filtered candidate", (t) => {
	const { sent, emit } = harness(t);
	emit("message_end", notice("m1", "Background task completed: **worker**", []));
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /only a candidate/i);
});

test("failures announce regardless of duration", (t) => {
	const { sent, emit } = harness(t);
	emit("message_end", notice("m1", "Background task failed: **worker**", [
		{ agent: "worker", status: "failed", durationMs: 1_154 },
	]));
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /"failure"/);
});

test("a stopped run announces as stopped", (t) => {
	const { sent, emit } = harness(t);
	emit("message_end", notice("m1", "Background task stopped: **workflow**", [
		{ agent: "workflow", status: "stopped", durationMs: 1_085_263 },
	]));
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /"stopped"/);
});

test("structured status outranks the body wording", (t) => {
	const { sent, emit } = harness(t);
	emit(
		"message_end",
		notice("m1", "Background task completed: **reviewer**\n\nthe build task failed", [
			{ agent: "reviewer", status: "completed", durationMs: 300_000 },
		]),
	);
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /"long-completion"/);
});

test("stopped runs stay silent when the trigger is disarmed", (t) => {
	const { sent, emit } = harness(t, {
		...ARMED,
		announceOn: ["needs-input", "failure", "long-completion"],
	});
	emit("message_end", notice("m1", "Background task stopped: **workflow**", [
		{ agent: "workflow", status: "stopped", durationMs: 1_085_263 },
	]));
	assert.equal(sent.length, 0);
});

// ── session lifecycle and stale timing (audit fixes) ────────────────────────

const tick = (callId, taskId, status) => ({
	toolName: "TaskUpdate",
	toolCallId: callId,
	args: { taskId, status },
});

test("a failed terminal update closes the timing window", (t) => {
	// Without this, a completed retry inherits the abandoned run's start and is
	// announced as a long job it never was.
	const { sent, emit } = harness(t);
	emit("tool_execution_start", tick("s1", "1", "in_progress"));
	t.mock.timers.tick(10_000);
	emit("tool_execution_start", tick("d1", "1", "completed"));
	emit("tool_execution_end", {
		toolName: "TaskUpdate",
		toolCallId: "d1",
		isError: true,
	});
	t.mock.timers.tick(200_000);
	emit("tool_execution_start", tick("d2", "1", "completed"));
	emit("tool_execution_end", {
		toolName: "TaskUpdate",
		toolCallId: "d2",
		isError: false,
	});
	assert.equal(sent.length, 0, "the abandoned start must not be measured");
});

test("reset() gives the next session a clean slate", (t) => {
	const { sent, emit, reset } = harness(t);
	const completion = {
		message: {
			role: "custom",
			customType: "subagent-notify",
			id: "msg-1",
			content: "Background task completed: **worker**",
			details: { runs: [{ status: "completed", durationMs: 300_000 }] },
		},
	};
	emit("message_end", completion);
	assert.equal(sent.length, 1);
	reset();
	t.mock.timers.tick(60_000);
	emit("message_end", completion);
	assert.equal(sent.length, 2, "a new session may nudge for the same event");
});

test("session memory is bounded, oldest keys evicted first", (t) => {
	const { sent, emit } = harness(t);
	const notice = (id) => ({
		message: {
			role: "user",
			id,
			content: "Background task completed: **worker**",
		},
	});
	// 256 is the documented cap; go past it so the first key falls out.
	for (let i = 0; i < 300; i += 1) {
		t.mock.timers.tick(6_000);
		emit("message_end", notice(`msg-${i}`));
	}
	const before = sent.length;
	t.mock.timers.tick(6_000);
	emit("message_end", notice("msg-0"));
	assert.equal(sent.length, before + 1, "the first key was evicted, not kept forever");
});
