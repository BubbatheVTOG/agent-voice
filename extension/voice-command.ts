/**
 * /voice command: on | off | status | stop.
 *
 * Session-scoped switches (in-memory, no persistence) plus a live status view
 * that reports the resolved config with per-key provenance.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { VALID_TRIGGERS, type Trigger, type VoiceConfig } from "./config";
import { getPlaybackStatus, stopPlayback } from "./speak";

export interface VoiceStatusContext {
	cwd: string;
	isProjectTrusted(): boolean;
	ui: {
		setStatus(key: string, value: string): void;
	};
}

interface SessionPolicy {
	autoAnnounce?: boolean;
	longJobThresholdSec?: number;
	announceOn?: Trigger[];
}

interface Deps {
	getConfig: (cwd: string, projectTrusted: boolean) => VoiceConfig;
	setSessionEnabled: (v: boolean) => void;
	setSessionPolicy: (policy: SessionPolicy) => void;
	publishStatus?: (ctx: VoiceStatusContext) => void;
}

const SUBCOMMANDS = ["on", "off", "status", "stop"] as const;

function parseBoolean(value: string): boolean | undefined {
	if (value === "on" || value === "true") return true;
	if (value === "off" || value === "false") return false;
	return undefined;
}

export function parsePolicy(
	args: string,
): { policy: SessionPolicy; label: string } | { error: string } | null {
	const parts = args.trim().split(/\s+/);
	if (parts.length < 2) return null;
	const key = parts[0];
	const value = parts.slice(1).join(" ");
	if (key === "autoannounce" || key === "auto-announce") {
		const parsed = parseBoolean(value);
		return parsed === undefined
			? { error: `autoAnnounce expects on|off, got "${value}"` }
			: { policy: { autoAnnounce: parsed }, label: `autoAnnounce=${parsed}` };
	}
	if (key === "threshold" || key === "longjobthresholdsec") {
		const parsed = Number(value);
		return !Number.isFinite(parsed) || parsed <= 0
			? { error: `threshold expects a positive number of seconds, got "${value}"` }
			: { policy: { longJobThresholdSec: parsed }, label: `threshold=${parsed}s` };
	}
	if (key === "announceon" || key === "announce-on") {
		const names = value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		const triggers = names.filter((item): item is Trigger =>
			(VALID_TRIGGERS as readonly string[]).includes(item),
		);
		if (triggers.length === 0 || triggers.length !== names.length)
			return {
				error: `announceOn expects comma-separated triggers: ${VALID_TRIGGERS.join(", ")}`,
			};
		return {
			policy: { announceOn: triggers },
			label: `announceOn=${triggers.join(",")}`,
		};
	}
	return {
		error: `unknown option "${key}" (use autoAnnounce, threshold, or announceOn)`,
	};
}

export function registerVoiceCommand(pi: ExtensionAPI, deps: Deps): void {
	pi.registerCommand("voice", {
		description:
			"agent-voice: /voice on|off|status|stop or /voice <option> <value> — control spoken announcements",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [];
			for (const c of SUBCOMMANDS) {
				if (c.startsWith(prefix)) items.push({ value: c, label: c });
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const rawArgs = (args ?? "status").trim();
			const sub = rawArgs.toLowerCase();
			const cfg = deps.getConfig(ctx.cwd, ctx.isProjectTrusted());

			if (sub === "stop") {
				const killed = stopPlayback();
				if (killed > 0) {
					ctx.ui.notify(`voice: ${killed} announcement(s) stopped`, "info");
				} else {
					ctx.ui.notify("voice: nothing is playing", "warning");
				}
				return;
			}

			if (sub === "on") {
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
				return;
			}

			if (sub === "off") {
				deps.setSessionEnabled(false);
				deps.publishStatus?.(ctx);
				ctx.ui.notify("voice: OFF for this session", "info");
				return;
			}

			const parsedPolicy = parsePolicy(rawArgs);
			if (parsedPolicy) {
				if ("error" in parsedPolicy) {
					ctx.ui.notify(`voice: ${parsedPolicy.error}`, "warning");
					return;
				}
				if (cfg.envKill) {
					ctx.ui.notify(
						"voice: AGENT_VOICE_OFF=1 is set — policy changes are muted",
						"warning",
					);
					return;
				}
				deps.setSessionPolicy(parsedPolicy.policy);
				deps.publishStatus?.(ctx);
				ctx.ui.notify(`voice: ${parsedPolicy.label} for this session`, "info");
				return;
			}

			if (sub === "status" || sub === "") {
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
					.map(([name, val]) => {
						const layer = cfg.provenance[name] ?? "default";
						return `  ${name.padEnd(20)} ${val.padEnd(8)} (${layer})`;
					})
					.join("\n");
				const envNote = cfg.envKill
					? "  !! AGENT_VOICE_OFF=1 is set — everything is muted, including /voice on. !!"
					: "";
				const st = getPlaybackStatus();
				let playing = "";
				if (st.playing) {
					const extra = st.count > 1 ? ` — ${st.count} total` : "";
					playing = `\n  (an announcement is currently playing${extra} — /voice stop)`;
				}
				let errNote = "";
				if (st.lastError) {
					let logPath = "";
					if (st.lastError.stderrPath)
						logPath = ` (log: ${st.lastError.stderrPath})`;
					errNote = `\n  last error: ${st.lastError.summary}${logPath}`;
				}
				ctx.ui.notify(
					`voice status:${envNote}\n${lines}\n  announceOn            ${cfg.announceOn.join(", ")}${playing}${errNote}`,
					"info",
				);
				return;
			}

			ctx.ui.notify(
				`voice: unknown command "${sub}" (use: on | off | status | stop | <option> <value>)`,
				"warning",
			);
		},
	});
}
