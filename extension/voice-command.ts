/**
 * /voice command: on | off | status | stop, plus policy options.
 *
 * Session-scoped switches (in-memory, no persistence) and a live status view
 * that reports the resolved config with per-key provenance.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	VALID_TRIGGERS,
	type ConfigFor,
	type Trigger,
	type VoiceConfig,
} from "./config.ts";
import { getPlaybackStatus, stopPlayback } from "./playback.ts";

export interface VoiceStatusContext {
	cwd: string;
	isProjectTrusted(): boolean;
	ui: {
		setStatus(key: string, value: string): void;
		notify(message: string, level?: "info" | "warning" | "error"): void;
	};
}

export interface SessionPolicy {
	autoAnnounce?: boolean;
	longJobThresholdSec?: number;
	announceOn?: Trigger[];
}

interface Deps {
	getConfig: ConfigFor;
	setSessionEnabled(value: boolean): void;
	setSessionPolicy(policy: SessionPolicy): void;
	publishStatus?(ctx: VoiceStatusContext): void;
}

const SUBCOMMANDS = ["on", "off", "status", "stop"] as const;

type PolicyParse =
	| { policy: SessionPolicy; label: string }
	| { error: string };

function parseBoolean(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "on" || normalized === "true") return true;
	if (normalized === "off" || normalized === "false") return false;
	return undefined;
}

function parseAutoAnnounce(value: string): PolicyParse {
	const parsed = parseBoolean(value);
	if (parsed === undefined) {
		return { error: `autoAnnounce expects on|off, got "${value}"` };
	}
	return { policy: { autoAnnounce: parsed }, label: `autoAnnounce=${parsed}` };
}

function parseThreshold(value: string): PolicyParse {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return {
			error: `threshold expects a positive number of seconds, got "${value}"`,
		};
	}
	return { policy: { longJobThresholdSec: parsed }, label: `threshold=${parsed}s` };
}

function parseAnnounceOn(value: string): PolicyParse {
	const names = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	const triggers = names.filter((item): item is Trigger =>
		(VALID_TRIGGERS as readonly string[]).includes(item),
	);
	if (triggers.length === 0 || triggers.length !== names.length) {
		return {
			error: `announceOn expects comma-separated triggers: ${VALID_TRIGGERS.join(", ")}`,
		};
	}
	return { policy: { announceOn: triggers }, label: `announceOn=${triggers.join(",")}` };
}

// Hyphens and underscores are cosmetic: `auto-announce` and `autoannounce` are
// the same option, so one normalized table serves both spellings.
const POLICY_KEYS: Record<string, (value: string) => PolicyParse> = {
	autoannounce: parseAutoAnnounce,
	threshold: parseThreshold,
	longjobthresholdsec: parseThreshold,
	announceon: parseAnnounceOn,
};

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[-_]/g, "");
}

export function parsePolicy(args: string): PolicyParse | null {
	const parts = args.trim().split(/\s+/);
	if (parts.length < 2) return null;
	const parse = POLICY_KEYS[normalizeKey(parts[0])];
	if (!parse) {
		return {
			error: `unknown option "${parts[0]}" (use autoAnnounce, threshold, or announceOn)`,
		};
	}
	return parse(parts.slice(1).join(" "));
}

function formatStatus(
	cfg: VoiceConfig,
	playback: ReturnType<typeof getPlaybackStatus>,
): string {
	const rows: Array<[string, string]> = [
		["enabled", String(cfg.enabled)],
		["autoAnnounce", String(cfg.autoAnnounce)],
		["longJobThresholdSec", String(cfg.longJobThresholdSec)],
		["wordBudget", String(cfg.wordBudget)],
		["wordHardCap", String(cfg.wordHardCap)],
		["voice", cfg.voice],
		["speed", String(cfg.speed)],
	];
	const lines = rows
		.map(([name, value]) => {
			const layer = cfg.provenance[name] ?? "default";
			return `  ${name.padEnd(20)} ${value.padEnd(8)} (${layer})`;
		})
		.join("\n");
	const notes: string[] = [];
	if (cfg.envKill) {
		notes.push(
			"  !! AGENT_VOICE_OFF=1 is set — everything is muted, including /voice on. !!",
		);
	}
	if (playback.playing) {
		const extra = playback.count > 1 ? ` — ${playback.count} total` : "";
		notes.push(`  (an announcement is currently playing${extra} — /voice stop)`);
	}
	if (playback.lastError) {
		const log = playback.lastError.stderrPath
			? ` (log: ${playback.lastError.stderrPath})`
			: "";
		notes.push(`  last error: ${playback.lastError.summary}${log}`);
	}
	const body = [
		`  announceOn            ${cfg.announceOn.join(", ")}`,
		...notes,
	].join("\n");
	return `voice status:\n${lines}\n${body}`;
}

interface ActionInput {
	cfg: VoiceConfig;
	ctx: VoiceStatusContext;
	deps: Deps;
}

type Action = (input: ActionInput) => void;

function stopAction({ ctx }: ActionInput): void {
	const { signalled, cancelled } = stopPlayback();
	if (signalled > 0) {
		const plural = signalled === 1 ? "" : "s";
		ctx.ui.notify(`voice: ${signalled} announcement${plural} stopped`, "info");
		return;
	}
	if (cancelled) {
		ctx.ui.notify("voice: daemon playback cancelled", "info");
		return;
	}
	ctx.ui.notify("voice: nothing is playing", "warning");
}

function onAction({ cfg, ctx, deps }: ActionInput): void {
	if (cfg.envKill) {
		deps.publishStatus?.(ctx);
		ctx.ui.notify(
			"voice: AGENT_VOICE_OFF=1 is set — the kill switch mutes everything. Unset it to use voice.",
			"warning",
		);
		return;
	}
	deps.setSessionEnabled(true);
	deps.publishStatus?.(ctx);
	ctx.ui.notify(
		"voice: ON for this session (speech and automatic announcements)",
		"info",
	);
}

function offAction({ ctx, deps }: ActionInput): void {
	deps.setSessionEnabled(false);
	deps.publishStatus?.(ctx);
	ctx.ui.notify("voice: OFF for this session", "info");
}

function statusAction({ cfg, ctx }: ActionInput): void {
	ctx.ui.notify(formatStatus(cfg, getPlaybackStatus()), "info");
}

const ACTIONS: Record<string, Action> = {
	stop: stopAction,
	on: onAction,
	off: offAction,
	status: statusAction,
};

function applyPolicy(parsed: PolicyParse, { cfg, ctx, deps }: ActionInput): void {
	if ("error" in parsed) {
		ctx.ui.notify(`voice: ${parsed.error}`, "warning");
		return;
	}
	if (cfg.envKill) {
		ctx.ui.notify(
			"voice: AGENT_VOICE_OFF=1 is set — policy changes are muted",
			"warning",
		);
		return;
	}
	deps.setSessionPolicy(parsed.policy);
	deps.publishStatus?.(ctx);
	ctx.ui.notify(`voice: ${parsed.label} for this session`, "info");
}

export function registerVoiceCommand(pi: ExtensionAPI, deps: Deps): void {
	pi.registerCommand("voice", {
		description:
			"agent-voice: /voice on|off|status|stop or /voice <option> <value> — control spoken announcements",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = SUBCOMMANDS.flatMap((name) =>
				name.startsWith(prefix) ? [{ value: name, label: name }] : [],
			);
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx: VoiceStatusContext) => {
			// `/voice` with no argument is the status view, not an error.
			const rawArgs = (args ?? "").trim() || "status";
			const input: ActionInput = {
				cfg: deps.getConfig(ctx.cwd, ctx.isProjectTrusted()),
				ctx,
				deps,
			};
			const action = ACTIONS[rawArgs.toLowerCase()];
			if (action) {
				action(input);
				return;
			}
			const parsed = parsePolicy(rawArgs);
			if (parsed) {
				applyPolicy(parsed, input);
				return;
			}
			ctx.ui.notify(
				`voice: unknown command "${rawArgs}" (use: on | off | status | stop | <option> <value>)`,
				"warning",
			);
		},
	});
}
