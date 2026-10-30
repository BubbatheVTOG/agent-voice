import test from "node:test";
import assert from "node:assert/strict";
import { parsePolicy, registerVoiceCommand } from "../extension/voice-command.ts";

test("announceOn accepts the current trigger set, including stopped", () => {
	const parsed = parsePolicy("announceOn needs-input,stopped");
	assert.ok(parsed && "policy" in parsed);
	assert.deepEqual(parsed.policy.announceOn, ["needs-input", "stopped"]);
	assert.equal(parsed.label, "announceOn=needs-input,stopped");
});

test("announceOn rejects an unknown trigger instead of silently arming less", () => {
	const parsed = parsePolicy("announceOn failure,bogus");
	assert.ok(parsed && "error" in parsed);
	assert.match(parsed.error, /needs-input, failure, stopped, long-completion/);
});

test("threshold takes a positive number of seconds", () => {
	const parsed = parsePolicy("threshold 90");
	assert.ok(parsed && "policy" in parsed);
	assert.equal(parsed.policy.longJobThresholdSec, 90);

	const rejected = parsePolicy("threshold 0");
	assert.ok(rejected && "error" in rejected);
	assert.match(rejected.error, /positive number/);
});

test("option spelling is tolerant: hyphens and underscores are cosmetic", () => {
	const hyphenated = parsePolicy("auto-announce off");
	assert.ok(hyphenated && "policy" in hyphenated);
	assert.equal(hyphenated.policy.autoAnnounce, false);

	const underscored = parsePolicy("announce_on failure");
	assert.ok(underscored && "policy" in underscored);
	assert.deepEqual(underscored.policy.announceOn, ["failure"]);

	const long = parsePolicy("longJobThresholdSec 45");
	assert.ok(long && "policy" in long);
	assert.equal(long.policy.longJobThresholdSec, 45);
});

test("an unknown option is an error, and a bare subcommand is not a policy", () => {
	const unknown = parsePolicy("volume 9");
	assert.ok(unknown && "error" in unknown);
	assert.match(unknown.error, /unknown option "volume"/);

	assert.equal(parsePolicy("status"), null);
});

// ── dispatch (fake pi + ctx; no TUI) ────────────────────────────────────────

const CFG = {
	enabled: false,
	autoAnnounce: false,
	longJobThresholdSec: 120,
	wordBudget: 45,
	wordHardCap: 60,
	voice: "af_aoede",
	speed: 1.2,
	announceOn: ["needs-input", "failure", "stopped", "long-completion"],
	provenance: {},
	envKill: false,
};

async function dispatch(args) {
	const notified = [];
	let command;
	const pi = {
		registerCommand: (name, definition) => {
			command = { name, definition };
		},
	};
	const applied = [];
	registerVoiceCommand(pi, {
		getConfig: () => CFG,
		setSessionEnabled: (value) => applied.push(["enabled", value]),
		setSessionPolicy: (policy) => applied.push(["policy", policy]),
	});
	const ctx = {
		cwd: "/tmp",
		isProjectTrusted: () => true,
		ui: {
			notify: (message) => notified.push(message),
			setStatus: () => {},
		},
	};
	await command.definition.handler(args, ctx);
	return { notified, applied };
}

test("a bare /voice shows status instead of an unknown-command warning", async () => {
	for (const args of ["", "   ", undefined]) {
		const { notified } = await dispatch(args);
		assert.match(notified[0], /^voice status:/);
	}
});

test("/voice on and off flip the session switch", async () => {
	assert.deepEqual((await dispatch("on")).applied, [["enabled", true]]);
	assert.deepEqual((await dispatch("off")).applied, [["enabled", false]]);
});

test("a policy option reaches the session policy, an unknown one warns", async () => {
	const ok = await dispatch("threshold 30");
	assert.deepEqual(ok.applied, [["policy", { longJobThresholdSec: 30 }]]);

	const bad = await dispatch("volume 9");
	assert.equal(bad.applied.length, 0);
	assert.match(bad.notified[0], /unknown option "volume"/);
});
