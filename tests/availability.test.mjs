import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { resolveAgentSayBin } from "../extension/availability.ts";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "pi-voice-availability-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".local", "bin");
  mkdirSync(directory, { recursive: true });
  return { home, bin: join(directory, "agent-say") };
}

test("missing executable leaves voice unavailable", (t) => {
  const { home } = fixture(t);
  assert.equal(resolveAgentSayBin({}, home), null);
});

test("only a regular executable file satisfies the CLI prerequisite", (t) => {
  const { home, bin } = fixture(t);
  writeFileSync(bin, "fixture; never execute", { mode: 0o600 });
  assert.equal(resolveAgentSayBin({}, home), null);
  chmodSync(bin, 0o700);
  assert.equal(resolveAgentSayBin({}, home), bin);
  assert.equal(resolveAgentSayBin({ AGENT_SAY_BIN: home }, home), null);
});

test("an invalid explicit backend does not silently select the default", (t) => {
  const { home, bin } = fixture(t);
  writeFileSync(bin, "fixture; never execute", { mode: 0o700 });
  assert.equal(
    resolveAgentSayBin({ AGENT_SAY_BIN: join(home, "missing") }, home),
    null,
  );
  assert.equal(resolveAgentSayBin({ AGENT_SAY_BIN: "" }, home), null);
});

test("executable symlinks work; broken symlinks do not", (t) => {
  const { home, bin } = fixture(t);
  const target = join(home, "backend");
  symlinkSync(target, bin);
  assert.equal(resolveAgentSayBin({}, home), null);
  writeFileSync(target, "fixture; never execute", { mode: 0o700 });
  assert.equal(resolveAgentSayBin({}, home), bin);
});

async function registrations(available) {
  const calls = [];
  const context = vm.createContext({ process: { env: {} } });
  const exportsByPath = {
    "./availability.ts": {
      resolveAgentSayBin: () => (available ? "/fixture/agent-say" : null),
    },
    "./config": { DEFAULTS: {}, resolveConfig: () => ({}) },
    "./speak": {
      registerSpeakTool: () => calls.push("speak"),
      stopPlayback: () => {},
    },
    "./voice-command": { registerVoiceCommand: () => calls.push("voice") },
    "./policy": { registerAutoAnnounce: () => calls.push("policy") },
  };
  const source = readFileSync(
    new URL("../extension/index.ts", import.meta.url),
    "utf8",
  );
  const module = new vm.SourceTextModule(stripTypeScriptTypes(source), {
    context,
  });
  await module.link((path) => {
    const exports = exportsByPath[path];
    assert.ok(exports, `Unexpected dependency: ${path}`);
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports))
          this.setExport(name, value);
      },
      { context },
    );
  });
  await module.evaluate();
  await module.namespace.default({ on: (name) => calls.push(name) });
  return calls;
}

test("no voice tools, commands, policies, or status hooks register without the backend", async () => {
  assert.deepEqual(await registrations(false), []);
});

test("an available backend retains the existing opt-in voice integration", async () => {
  const calls = await registrations(true);
  for (const expected of [
    "speak",
    "voice",
    "policy",
    "session_start",
    "session_shutdown",
  ]) {
    assert.ok(calls.includes(expected), expected);
  }
});
