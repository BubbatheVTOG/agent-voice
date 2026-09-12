/**
 * /voice command: on | off | status | stop.
 *
 * Session-scoped switches (in-memory, no persistence) plus a live status view
 * that reports the resolved config with per-key provenance.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { VoiceConfig } from "./config";
import { getPlaybackStatus, stopPlayback } from "./speak";

interface Deps {
	getConfig: (cwd: string, projectTrusted: boolean) => VoiceConfig;
	setSessionEnabled: (v: boolean) => void;
}

const SUBCOMMANDS = ["on", "off", "status", "stop"] as const;

export function registerVoiceCommand(pi: ExtensionAPI, deps: Deps): void {
	pi.registerCommand("voice", {
		description:
			"agent-voice: /voice on|off|status|stop — control spoken announcements",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [];
			for (const c of SUBCOMMANDS) {
				if (c.startsWith(prefix)) items.push({ value: c, label: c });
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "status").trim().toLowerCase();
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
					ctx.ui.notify(
						"voice: AGENT_VOICE_OFF=1 is set — the kill switch mutes everything. Unset it to use voice.",
						"warning",
					);
					return;
				}
				deps.setSessionEnabled(true);
				ctx.ui.notify(
					"voice: ON for this session (auto-announce additionally needs agentVoice.autoAnnounce)",
					"info",
				);
				return;
			}

			if (sub === "off") {
				deps.setSessionEnabled(false);
				ctx.ui.notify("voice: OFF for this session", "info");
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
				`voice: unknown subcommand "${sub}" (use: on | off | status | stop)`,
				"warning",
			);
		},
	});
}
