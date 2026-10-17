// Runs the stdlib-only TTS unit tests (tts/tests). They need no model, no
// numpy and no audio device, so they run under the CI interpreter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("tts python unit tests pass (stdlib only)", () => {
	const result = spawnSync(
		"python3",
		["-m", "unittest", "discover", "-s", "tts/tests", "-p", "test_*.py"],
		{ cwd: root, encoding: "utf8", timeout: 120_000 },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
});
