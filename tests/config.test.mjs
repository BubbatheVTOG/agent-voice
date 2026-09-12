import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../extension/config.ts";

// Fixtures live in throwaway temp dirs; cleaned up after the file finishes.
const fixtures = [];
function fixture(globalCfg = null, projectCfg = null) {
	const home = mkdtempSync(join(tmpdir(), "av-home-"));
	const proj = mkdtempSync(join(tmpdir(), "av-proj-"));
	fixtures.push(home, proj);
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	if (globalCfg !== null)
		writeFileSync(
			join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ agentVoice: globalCfg }),
		);
	if (projectCfg !== null) {
		mkdirSync(join(proj, ".pi"), { recursive: true });
		writeFileSync(join(proj, ".pi", "settings.json"), projectCfg);
	}
	return { home, proj };
}
after(() => {
	for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

const resolve = (o) =>
	resolveConfig({ cwd: "/nonexistent", session: {}, env: {}, ...o });

test("defaults when nothing is configured (both features off)", () => {
	const c = resolve({ homeDir: "/nonexistent-home" });
	assert.equal(c.enabled, false);
	assert.equal(c.autoAnnounce, false);
	assert.equal(c.wordBudget, 45);
	assert.equal(c.wordHardCap, 60);
	assert.equal(c.longJobThresholdSec, 120);
	assert.equal(c.announceOn.length, 3);
	assert.equal(c.envKill, false);
	assert.equal(c.speed, 1.2);
	assert.equal(c.voice, "af_aoede");
});

test("global layer applies; over-budget values clamp to the hard cap", () => {
	const { home } = fixture({ enabled: true, voice: "am_liam", wordBudget: 400 });
	const c = resolve({ homeDir: home });
	assert.equal(c.enabled, true);
	assert.equal(c.provenance.enabled, "global");
	assert.equal(c.voice, "am_liam");
	assert.equal(c.wordBudget, 60, "400 clamps down to the default cap");
	assert.equal(c.wordHardCap, 60);
	assert.equal(c.autoAnnounce, false);
});

test("project layer wins over global; provenance is stamped per key", () => {
	const { home, proj } = fixture(
		{ enabled: true, voice: "am_liam", wordBudget: 400 },
		JSON.stringify({
			agentVoice: {
				autoAnnounce: true,
				wordBudget: 40,
				wordHardCap: 55,
				longJobThresholdSec: 90,
			},
		}),
	);
	const c = resolve({ homeDir: home, cwd: proj });
	assert.equal(c.wordBudget, 40);
	assert.equal(c.provenance.wordBudget, "project");
	assert.equal(c.wordHardCap, 55);
	assert.equal(c.autoAnnounce, true);
	assert.equal(c.provenance.autoAnnounce, "project");
	assert.equal(c.longJobThresholdSec, 90);
	assert.equal(c.provenance.longJobThresholdSec, "project");
	// keys the project did NOT set fall through to the lower layers
	assert.equal(c.voice, "am_liam");
	assert.equal(c.provenance.voice, "global");
	assert.equal(c.speed, 1.2);
	assert.equal(c.provenance.speed, "default");
});

test("session off beats global on", () => {
	const { home } = fixture({ enabled: true });
	const c = resolve({ homeDir: home, session: { enabled: false } });
	assert.equal(c.enabled, false);
	assert.equal(c.provenance.enabled, "session");
});

test("AGENT_VOICE_OFF=1 wins over everything, including /voice on", () => {
	const { home, proj } = fixture(
		{ enabled: true, autoAnnounce: true },
		JSON.stringify({ agentVoice: { autoAnnounce: true } }),
	);
	const c = resolve({
		homeDir: home,
		cwd: proj,
		session: { enabled: true },
		env: { AGENT_VOICE_OFF: "1" },
	});
	assert.equal(c.enabled, false);
	assert.equal(c.autoAnnounce, false);
	assert.equal(c.envKill, true);
	assert.equal(c.provenance.enabled, "env");
});

test("malformed project config fails closed (lower layers still apply)", () => {
	const { home, proj } = fixture({ enabled: true }, "{ not json");
	const c = resolve({ homeDir: home, cwd: proj });
	assert.equal(c.enabled, true);
	assert.equal(c.autoAnnounce, false);
});

test("untrusted project: the project layer is skipped", () => {
	const { home, proj } = fixture(
		null,
		JSON.stringify({ agentVoice: { autoAnnounce: true } }),
	);
	const c = resolve({ homeDir: home, cwd: proj, projectTrusted: false });
	assert.equal(c.autoAnnounce, false);
});

test("invalid values at a layer are ignored; the next lower layer applies", () => {
	const { home, proj } = fixture(
		{ wordBudget: 400 },
		JSON.stringify({
			agentVoice: {
				wordBudget: "many",
				speed: -3,
				longJobThresholdSec: 0,
				announceOn: "all",
				enabled: null,
			},
		}),
	);
	const c = resolve({ homeDir: home, cwd: proj });
	assert.equal(
		c.wordBudget,
		60,
		"project 'many' invalid -> global 400 -> clamped to default cap",
	);
	assert.equal(c.speed, 1.2);
	assert.equal(c.longJobThresholdSec, 120);
	assert.equal(
		c.enabled,
		false,
		"project null invalid -> not in global -> default",
	);
	assert.equal(c.announceOn.length, 3);
});

test("unknown entries inside a valid announceOn are filtered, valid ones kept", () => {
	const { home } = fixture({ announceOn: ["failure", "bogus", "needs-input"] });
	const c = resolve({ homeDir: home });
	assert.deepEqual(c.announceOn, ["failure", "needs-input"]);
});

test("an all-unknown announceOn never wins a layer (no silent disarm)", () => {
	const { home, proj } = fixture(
		{ announceOn: ["failure"] },
		JSON.stringify({ agentVoice: { announceOn: ["needs-imput"] } }), // typo'd
	);
	const c = resolve({ homeDir: home, cwd: proj });
	assert.deepEqual(
		c.announceOn,
		["failure"],
		"project's all-unknown list is ignored; the global layer applies",
	);
	assert.equal(c.provenance.announceOn, "global");
});

test("AGENT_VOICE_OFF mutes only on the literal 1 (documented, deterministic)", () => {
	const { home } = fixture({ enabled: true });
	const withEnv = (val) => resolve({ homeDir: home, env: { AGENT_VOICE_OFF: val } });
	assert.equal(withEnv("1").envKill, true);
	assert.equal(withEnv("1").enabled, false);
	assert.equal(withEnv("0").envKill, false);
	assert.equal(withEnv("0").enabled, true);
	assert.equal(withEnv("").envKill, false);
	assert.equal(
		withEnv("true").envKill,
		false,
		"the documented form is =1; other values are ignored by design",
	);
});
