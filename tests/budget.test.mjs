import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceBudget } from "../extension/speak.ts";

const cfg = (over = {}) => ({ wordBudget: 45, wordHardCap: 60, ...over });
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const DIR = join(tmpdir(), "agent-voice");

test("under the cap: passthrough, no file written", () => {
	const r = enforceBudget(words(20), cfg());
	assert.equal(r.truncated, false);
	assert.equal(r.keptWords, 20);
	assert.equal(r.originalWords, 20);
	assert.equal(r.fullTextPath, null);
	assert.equal(r.text, words(20));
});

test("exactly at the cap: passthrough", () => {
	const r = enforceBudget(words(60), cfg());
	assert.equal(r.truncated, false);
	assert.equal(r.keptWords, 60);
});

test("over the cap: truncated to the cap, full text saved 0600", () => {
	const r = enforceBudget(words(80), cfg());
	assert.equal(r.truncated, true);
	assert.equal(r.keptWords, 60);
	assert.equal(r.originalWords, 80);
	assert.equal(r.text.split(/\s+/).length, 60);
	assert.ok(r.fullTextPath, "full text path present");
	assert.ok(r.fullTextPath.startsWith(DIR), "saved under $TMPDIR/agent-voice");
	assert.equal(statSync(r.fullTextPath).mode & 0o777, 0o600, "file is 0600");
	assert.equal(readFileSync(r.fullTextPath, "utf8"), words(80), "full original text preserved");
	rmSync(r.fullTextPath);
});

test("a custom hard cap is honored", () => {
	const r = enforceBudget(words(37), cfg({ wordHardCap: 15 }));
	assert.equal(r.truncated, true);
	assert.equal(r.keptWords, 15);
	assert.equal(r.text.split(/\s+/).length, 15);
	rmSync(r.fullTextPath);
});

test("between budget and cap: no truncation (the soft-budget advisory is the tool's job)", () => {
	const r = enforceBudget(words(50), cfg());
	assert.equal(r.truncated, false);
	assert.equal(r.keptWords, 50);
	assert.equal(r.fullTextPath, null);
});
