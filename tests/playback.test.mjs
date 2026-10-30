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
} from "../extension/playback.ts";

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
const request = (text) => ({ text, voice: CFG.voice, speed: CFG.speed });
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
		request(
			`Playback completion test. This one plays to the end. The flag -o ${INJECT} is spoken as words, never parsed as an option.`,
		),
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
		request(
			"Playback test one. This announcement is intentionally long so that it is still audibly playing when the stop arrives several seconds from now, well past the model load and synthesis.",
		),
	);
	const p2 = speakText(
		request(
			"Playback test two. Also intentionally long for the same reason, so the stop lands mid playback and not during synthesis or loading.",
		),
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
	const stopped = stopPlayback();
	assert.equal(stopped.signalled, 2, "every running announcement was signalled");
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

test("a non-executable backend is rejected before spawn", () => {
	const directory = mkdtempSync(join(tmpdir(), "av-bad-"));
	const bad = join(directory, "agent-say");
	const previous = process.env.AGENT_SAY_BIN;
	writeFileSync(bad, "#!/bin/sh\nexit 1\n");
	chmodSync(bad, 0o000);
	process.env.AGENT_SAY_BIN = bad;
	try {
		assert.equal(speakText(request("hello")), null);
		const st = getPlaybackStatus();
		assert.ok(st.lastError, "lastError recorded");
		assert.match(st.lastError.summary, /not an executable file/i);
		assert.equal(st.lastError.stderrPath, "");
	} finally {
		if (previous === undefined) delete process.env.AGENT_SAY_BIN;
		else process.env.AGENT_SAY_BIN = previous;
		chmodSync(bad, 0o644);
		rmSync(directory, { recursive: true, force: true });
	}
});

// ── stop/cancel contract and error bookkeeping (no real TTS) ────────────────

function fakeBackend(body) {
	const dir = mkdtempSync(join(tmpdir(), "av-fake-"));
	const bin = join(dir, "agent-say");
	writeFileSync(bin, `#!/bin/sh\n${body}\n`);
	chmodSync(bin, 0o755);
	return { dir, bin };
}

async function settle(deadlineMs = 10_000) {
	const deadline = Date.now() + deadlineMs;
	while (getPlaybackStatus().count > 0 && Date.now() < deadline) await sleep(50);
}

test("stop asks the daemon to cancel even when no child is live", () => {
	// CONTRACT.md: the daemon plays outside the announcement's process group,
	// so --cancel is the only path that reaches audio whose child already exited.
	const fake = fakeBackend("exit 0");
	const previous = process.env.AGENT_SAY_BIN;
	process.env.AGENT_SAY_BIN = fake.bin;
	try {
		const result = stopPlayback();
		assert.equal(result.signalled, 0, "nothing was playing");
		assert.equal(result.cancelled, true, "the daemon was still asked to cancel");
	} finally {
		process.env.AGENT_SAY_BIN = previous ?? "";
		if (previous === undefined) delete process.env.AGENT_SAY_BIN;
		rmSync(fake.dir, { recursive: true, force: true });
	}
});

test("a stale failure is cleared by the next successful announcement", async () => {
	const failing = fakeBackend("exit 1");
	const passing = fakeBackend("exit 0");
	const previous = process.env.AGENT_SAY_BIN;
	try {
		process.env.AGENT_SAY_BIN = failing.bin;
		speakText(request("failing announcement"));
		await settle();
		assert.ok(getPlaybackStatus().lastError, "failure recorded");

		process.env.AGENT_SAY_BIN = passing.bin;
		speakText(request("successful announcement"));
		await settle();
		assert.equal(
			getPlaybackStatus().lastError,
			null,
			"a later success must not leave a stale error in /voice status",
		);
	} finally {
		if (previous === undefined) delete process.env.AGENT_SAY_BIN;
		else process.env.AGENT_SAY_BIN = previous;
		for (const fake of [failing, passing]) {
			rmSync(fake.dir, { recursive: true, force: true });
		}
	}
});
