import test from "node:test";
import assert from "node:assert/strict";
import { parsePolicy } from "../extension/voice-command.ts";

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
