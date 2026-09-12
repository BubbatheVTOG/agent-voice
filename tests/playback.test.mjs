import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPlaybackStatus,
	speakText,
	stopPlayback,
} from "../extension/speak.ts";

// Integration tests: they spawn real TTS (model load ≈ 5 s each) and play
// audio. Gated so unit CI stays fast and silent — run with AGENT_VOICE_E2E=1.
const on = process.env.AGENT_VOICE_E2E === "1";
const skip = on
	? false
	: "set AGENT_VOICE_E2E=1 to run (spawns real TTS, plays audio)";

const CFG = {
	enabled: true,
	autoAnnounce: false,
	longJobThresholdSec: 120,
	wordBudget: 45,
	wordHardCap: 60,
	voice: "af_aoede",
	speed: 1.2,
	announceOn: [],
	provenance: {},
	envKill: false,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = join(tmpdir(), "agent-voice");

test("simultaneous announcements are all tracked and stoppable (WCAG 1.4.2)", { skip }, async () => {
	const p1 = speakText(
		"Playback test one. This announcement is killed mid playback shortly now.",
		CFG,
	);
	const p2 = speakText(
		"Playback test two. Also killed. Brief and over in a moment now.",
		CFG,
	);
	assert.ok(p1 && p2, "both spawns returned pids");
	await sleep(9000); // cold model load + a few seconds of playback
	const st1 = getPlaybackStatus();
	assert.equal(st1.playing, true);
	assert.equal(st1.count, 2, "both still tracked — no orphaning");
	const killed = stopPlayback();
	assert.equal(killed, 2, "every running announcement was signalled");
	await sleep(2000);
	const st2 = getPlaybackStatus();
	assert.equal(st2.playing, false);
	assert.equal(st2.count, 0);
	assert.equal(st2.lastError, null, "a user stop is not an error");
	assert.equal(
		readdirSync(DIR).filter((f) => f.startsWith("stderr-")).length,
		0,
		"stderr logs cleaned up",
	);
});

test("spawn failures are surfaced, never silent", { skip }, async () => {
	const bad = join(mkdtempSync(join(tmpdir(), "av-bad-")), "agent-say");
	writeFileSync(bad, "#!/bin/sh\nexit 1\n");
	chmodSync(bad, 0o000); // not executable -> spawn EACCES
	process.env.AGENT_SAY_BIN = bad;
	try {
		const pid = speakText("hello", CFG);
		assert.equal(pid, null);
		await sleep(1000); // the 'error' handler is async
		const st = getPlaybackStatus();
		assert.ok(st.lastError, "lastError recorded");
		assert.match(st.lastError.summary, /failed to spawn|EACCES/i);
	} finally {
		delete process.env.AGENT_SAY_BIN;
		chmodSync(bad, 0o644);
	}
});
