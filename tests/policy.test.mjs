import assert from "node:assert/strict";
import test from "node:test";
import { registerAutoAnnounce } from "../extension/policy.ts";

const ARMED = {
	enabled: true,
	autoAnnounce: true,
	envKill: false,
	announceOn: ["needs-input", "failure", "long-completion"],
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
	registerAutoAnnounce(pi, () => config);
	const emit = (name, event) => {
		for (const fn of handlers.get(name) ?? []) fn(event, ctx);
	};
	return { sent, emit };
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
