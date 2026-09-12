import test from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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

// Crash debris from an interrupted prior E2E run must not fail this one.
const cleanStaleStderr = () => {
	try {
		for (const f of readdirSync(DIR))
			if (f.startsWith("stderr-")) rmSync(join(DIR, f));
	} catch {
		/* dir does not exist yet */
	}
};

// The backend plays through a NamedTemporaryFile WAV in the system temp dir.
const wavCount = () => {
	try {
		return readdirSync(tmpdir()).filter((f) => /^tmp.*\.wav$/.test(f)).length;
	} catch {
		return 0;
	}
};

test("a finished announcement leaves the manager; option-like words are spoken, never parsed", {
	skip,
}, async () => {
	cleanStaleStderr();
	const INJECT = "/tmp/av-inject-guard.wav";
	rmSync(INJECT, { force: true });
	const pid = speakText(
		`Playback completion test. This one plays to the end. The flag -o ${INJECT} is spoken as words, never parsed as an option.`,
		CFG,
	);
	assert.ok(pid, "spawn returned a pid");
	const deadline = Date.now() + 60_000;
	while (getPlaybackStatus().count > 0 && Date.now() < deadline) {
		await sleep(500);
	}
	const st = getPlaybackStatus();
	assert.equal(
		st.count,
		0,
		"natural completion must remove the entry from the manager",
	);
	assert.equal(st.playing, false);
	assert.equal(st.lastError, null, "a clean run is not an error");
	assert.equal(
		existsSync(INJECT),
		false,
		"spoken '-o PATH' words must never reach agent-say's argparse as options",
	);
	assert.equal(
		readdirSync(DIR).filter((f) => f.startsWith("stderr-")).length,
		0,
		"clean exit removed its stderr file",
	);
	rmSync(INJECT, { force: true });
});

test("simultaneous announcements are all tracked and stoppable; a user stop leaks no temp WAVs (WCAG 1.4.2)", {
	skip,
}, async () => {
	cleanStaleStderr();
	const wavsBase = wavCount();
	const p1 = speakText(
		"Playback test one. This announcement is intentionally long so that it is still audibly playing when the stop arrives several seconds from now, well past the model load and synthesis.",
		CFG,
	);
	const p2 = speakText(
		"Playback test two. Also intentionally long for the same reason, so the stop lands mid playback and not during synthesis or loading.",
		CFG,
	);
	assert.ok(p1 && p2, "both spawns returned pids");
	// Wait until both backends have written their temp WAVs (playback started).
	const deadline = Date.now() + 45_000;
	while (wavCount() < wavsBase + 2 && Date.now() < deadline) {
		await sleep(300);
	}
	assert.ok(
		wavCount() >= wavsBase + 2,
		"both temp WAVs written (playback started)",
	);
	await sleep(1000); // audibly mid-playback now
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
		wavCount(),
		wavsBase,
		"SIGTERM-killed backends cleaned up their temp WAVs",
	);
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
