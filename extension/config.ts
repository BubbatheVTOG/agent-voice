/**
 * Config resolution for agent-voice.
 *
 * Precedence (highest wins):
 *   1. AGENT_VOICE_OFF=1 env kill switch (wins over everything, read live)
 *   2. session state (in-memory, set by /voice on|off)
 *   3. project  <cwd>/.pi/settings.json  → "agentVoice" (trusted projects only)
 *   4. global   $PI_CODING_AGENT_DIR/settings.json, else ~/.pi/agent/settings.json
 *   5. defaults (both features OFF — voice is opt-in)
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const VALID_TRIGGERS = [
	"needs-input",
	"failure",
	"stopped",
	"long-completion",
] as const;
export type Trigger = (typeof VALID_TRIGGERS)[number];

export interface VoiceConfig {
	/** Manual `speak` tool usable by the model. */
	enabled: boolean;
	/** Auto-announce on job events. */
	autoAnnounce: boolean;
	/** Job duration (seconds) at which a SUCCESSFUL completion is announced. */
	longJobThresholdSec: number;
	/** Word budget targets. Hard cap is enforced in the tool. */
	wordBudget: number;
	wordHardCap: number;
	/** Passthrough to agent-say. */
	voice: string;
	speed: number;
	/** Which triggers fire when autoAnnounce is on. */
	announceOn: Trigger[];
	/** Where each value came from (for /voice status). */
	provenance: Record<
		string,
		"env" | "session" | "project" | "global" | "default"
	>;
	/** Env kill switch active. */
	envKill: boolean;
}

export const DEFAULTS = {
	enabled: false,
	autoAnnounce: false,
	longJobThresholdSec: 120,
	wordBudget: 45,
	wordHardCap: 60,
	voice: "af_aoede",
	speed: 1.2,
	announceOn: [...VALID_TRIGGERS],
} as const;

type ConfigKey = keyof typeof DEFAULTS;

interface RawConfig {
	enabled?: unknown;
	autoAnnounce?: unknown;
	longJobThresholdSec?: unknown;
	wordBudget?: unknown;
	wordHardCap?: unknown;
	voice?: unknown;
	speed?: unknown;
	announceOn?: unknown;
}

// ── I/O-boundary decoders: one per key; unknown in, validated value or undefined out ──

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isFiniteNum = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);
const isNonEmptyStr = (v: unknown): v is string =>
	typeof v === "string" && v.length > 0;

const decoders: Record<ConfigKey, (v: unknown) => unknown> = {
	enabled: (v) => (isBool(v) ? v : undefined),
	autoAnnounce: (v) => (isBool(v) ? v : undefined),
	longJobThresholdSec: (v) => (isFiniteNum(v) && v > 0 ? v : undefined),
	wordBudget: (v) => (isFiniteNum(v) && v >= 10 ? Math.floor(v) : undefined),
	wordHardCap: (v) => (isFiniteNum(v) && v >= 10 ? Math.floor(v) : undefined),
	voice: (v) => (isNonEmptyStr(v) ? v : undefined),
	speed: (v) => (isFiniteNum(v) && v > 0 ? v : undefined),
	announceOn: (v) => {
		if (!Array.isArray(v) || v.length === 0) return undefined;
		const filtered = v.filter((x): x is Trigger =>
			VALID_TRIGGERS.includes(x as Trigger),
		);
		// An all-unknown list must not win the layer — it would silently
		// disarm auto-announce. Fall through like any other invalid value.
		return filtered.length > 0 ? filtered : undefined;
	},
};

interface CachedBlock {
	mtimeMs: number;
	block: RawConfig;
}
const blockCache = new Map<string, CachedBlock>();
// A long-lived process can visit many project directories; keep the newest
// few settings files rather than every path it ever resolved.
const MAX_CACHED_SETTINGS = 8;

/**
 * The global layer is read on every message and tool call, so the parse is
 * reused while the file's mtime is unchanged. A malformed file is treated as
 * absent: config must never take the session down.
 */
function readAgentVoiceBlock(path: string): RawConfig {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		blockCache.delete(path);
		return {};
	}
	const cached = blockCache.get(path);
	if (cached?.mtimeMs === mtimeMs) return cached.block;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			agentVoice?: RawConfig;
		};
		const block = raw.agentVoice ?? {};
		rememberBlock(path, { mtimeMs, block });
		return block;
	} catch {
		rememberBlock(path, { mtimeMs, block: {} });
		return {};
	}
}

function rememberBlock(path: string, entry: CachedBlock): void {
	blockCache.delete(path);
	blockCache.set(path, entry);
	while (blockCache.size > MAX_CACHED_SETTINGS) {
		const oldest = blockCache.keys().next().value;
		if (oldest === undefined) return;
		blockCache.delete(oldest);
	}
}

/**
 * Pi's agent directory. This mirrors pi's own `normalizePath` for the override:
 * `~` and `~/x` expand, a `file://` URL is converted, and anything else is left
 * exactly as written (pi does not resolve relative paths, so neither do we).
 * Expanding differently would read a different file than the one pi writes.
 */
function agentDir(env: NodeJS.ProcessEnv, homeDir: string): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (!override) return join(homeDir, CONFIG_DIR_NAME, "agent");
	if (override === "~") return homeDir;
	if (override.startsWith("~/")) return join(homeDir, override.slice(2));
	if (override.startsWith("file://")) return fileURLToPath(override);
	return override;
}

/**
 * Merge one config layer into the running values. Later (higher-precedence)
 * layers call this last and thus win; provenance is stamped per key.
 */
function applyLayer(
	values: Record<string, unknown>,
	provenance: VoiceConfig["provenance"],
	layer: "global" | "project",
	raw: RawConfig,
): void {
	for (const key of Object.keys(DEFAULTS) as ConfigKey[]) {
		const decoded = decoders[key](raw[key]);
		if (decoded !== undefined) {
			values[key] = decoded;
			provenance[key] = layer;
		} else if (!(key in provenance)) {
			provenance[key] = "default";
		}
	}
}

export interface SessionVoiceConfig {
	enabled?: boolean;
	autoAnnounce?: boolean;
	longJobThresholdSec?: number;
	announceOn?: Trigger[];
}

export interface ResolveInput {
	cwd: string;
	session: SessionVoiceConfig;
	env: NodeJS.ProcessEnv;
	/** When false, the project layer is skipped (pi gates .pi/settings.json behind project trust). */
	projectTrusted?: boolean;
	homeDir?: string;
}

export function resolveConfig(input: ResolveInput): VoiceConfig {
	const home = input.homeDir ?? homedir();
	const global = readAgentVoiceBlock(
		join(agentDir(input.env, home), "settings.json"),
	);
	const project =
		input.projectTrusted === false
			? {}
			: readAgentVoiceBlock(join(input.cwd, CONFIG_DIR_NAME, "settings.json"));

	const provenance: VoiceConfig["provenance"] = {};
	const values: Record<string, unknown> = { ...DEFAULTS };
	// Ascending precedence: global, then project (later wins).
	applyLayer(values, provenance, "global", global);
	applyLayer(values, provenance, "project", project);

	const envKill = input.env.AGENT_VOICE_OFF === "1";

	let enabled = Boolean(values.enabled);
	if (input.session.enabled !== undefined) {
		enabled = input.session.enabled;
		provenance.enabled = "session";
	}
	let autoAnnounce = Boolean(values.autoAnnounce);
	if (input.session.autoAnnounce !== undefined) {
		autoAnnounce = input.session.autoAnnounce;
		provenance.autoAnnounce = "session";
	}
	if (input.session.longJobThresholdSec !== undefined) {
		values.longJobThresholdSec = input.session.longJobThresholdSec;
		provenance.longJobThresholdSec = "session";
	}
	if (input.session.announceOn !== undefined) {
		values.announceOn = input.session.announceOn;
		provenance.announceOn = "session";
	}
	if (envKill) {
		provenance.enabled = "env";
		provenance.autoAnnounce = "env";
	}

	// applyLayer only ever stores values the decoders accepted, so this is a
	// narrowing of a validated value, not an unverified cast.
	const announceOn =
		(values.announceOn as Trigger[] | undefined) ?? [...VALID_TRIGGERS];

	const wordHardCap = Math.max(
		10,
		Math.floor(Number(values.wordHardCap) || DEFAULTS.wordHardCap),
	);
	const wordBudget = Math.min(
		Math.max(10, Math.floor(Number(values.wordBudget) || DEFAULTS.wordBudget)),
		wordHardCap,
	);

	return {
		enabled: envKill ? false : enabled,
		autoAnnounce: envKill ? false : autoAnnounce,
		longJobThresholdSec:
			Number(values.longJobThresholdSec) || DEFAULTS.longJobThresholdSec,
		wordBudget,
		wordHardCap,
		voice: String(values.voice),
		speed: Number(values.speed) || DEFAULTS.speed,
		announceOn,
		provenance,
		envKill,
	};
}

/**
 * The resolver every module receives from `index.ts`: config is re-read per
 * call because the environment kill switch and settings edits apply live.
 */
export type ConfigFor = (cwd: string, projectTrusted: boolean) => VoiceConfig;
