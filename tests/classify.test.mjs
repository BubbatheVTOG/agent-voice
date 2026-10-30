import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../extension/policy.ts";

test("failure shapes are classified", () => {
	assert.equal(
		classify("Background task failed: **worker**\n\nworker: 400 bad request"),
		"failure",
	);
	assert.equal(
		classify("The build background task has failed, see log"),
		"failure",
	);
	assert.equal(classify("run failed: exit code 1"), "failure");
});

test("needs-input shapes are classified", () => {
	assert.equal(
		classify(
			"Subagent needs attention — it is waiting for your permission to run rm -rf",
		),
		"needs-input",
	);
	assert.equal(classify("awaiting your approval to continue"), "needs-input");
	assert.equal(classify("waiting for the user's input"), "needs-input");
});

test("successful task completions are candidates for model filtering", () => {
	assert.equal(
		classify("Background task completed: **worker** (all green)"),
		"long-completion",
	);
	assert.equal(
		classify("Detached foreground task completed: **worker**"),
		"long-completion",
	);
});

test("ordinary conversation and non-notification wording never trigger", () => {
	assert.equal(classify("hello, how are you doing?"), null);
	assert.equal(classify("the tests finished in 12 seconds, all passing"), null);
});

test("only the headline decides the trigger, never the body", () => {
	// A completion whose summary text happens to contain failure/needs-input
	// wording must stay a completion; the body is not a status.
	assert.equal(
		classify(
			"Background task completed: **reviewer**\n\nThe build task failed twice, then passed.",
		),
		"long-completion",
	);
	assert.equal(
		classify(
			"Background task completed: **worker**\n\nCoverage needs your input to finish.",
		),
		"long-completion",
	);
});

test("grouped notices classify like single ones", () => {
	assert.equal(
		classify("Background tasks completed (2): **scout**, **worker**"),
		"long-completion",
	);
	assert.equal(
		classify("Background tasks stopped (2): **scout**, **worker**"),
		"stopped",
	);
});

test("a stopped run is its own trigger, not a completion", () => {
	assert.equal(classify("Background task stopped: **workflow**"), "stopped");
	assert.equal(classify("Background task paused: **reviewer**"), "stopped");
});
