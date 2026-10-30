import test from "node:test";
import assert from "node:assert/strict";
import { createLog, levelFromEnv } from "../extension/log.ts";

test("level comes from AGENT_VOICE_LOG, then the older debug flag, then warn", () => {
	// warn by default: extension stderr is the terminal the TUI draws on.
	assert.equal(levelFromEnv({}), "warn");
	assert.equal(levelFromEnv({ AGENT_VOICE_DEBUG: "1" }), "debug");
	assert.equal(levelFromEnv({ AGENT_VOICE_LOG: "warn" }), "warn");
	assert.equal(levelFromEnv({ AGENT_VOICE_LOG: "SILENT" }), "silent");
	assert.equal(levelFromEnv({ AGENT_VOICE_LOG: "nonsense" }), "warn");
});

test("records carry a UTC timestamp, level name, and correlation id", () => {
	const lines = [];
	const log = createLog({ AGENT_VOICE_LOG: "debug" }, {
		write: (line) => lines.push(line),
	});
	log.child({ correlationId: "abc" }).info({ event: "playback.spawn", words: 3 });
	const record = JSON.parse(lines[0]);
	assert.match(record.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	assert.equal(record.level, "info");
	assert.equal(record.component, "agent-voice");
	assert.equal(record.event, "playback.spawn");
	assert.equal(record.correlationId, "abc");
});

test("announcement text is redacted at the sink", () => {
	const lines = [];
	const log = createLog({ AGENT_VOICE_LOG: "info" }, {
		write: (line) => lines.push(line),
	});
	log.info({ event: "playback.spawn", text: "secret spoken words" });
	assert.match(lines[0], /\[redacted\]/);
	assert.doesNotMatch(lines[0], /secret spoken words/);
});

test("an unusable sink degrades to silence instead of throwing", () => {
	const log = createLog({}, {
		write: () => {
			throw new Error("EPIPE");
		},
	});
	assert.doesNotThrow(() => log.info({ event: "playback.spawn" }));
});
