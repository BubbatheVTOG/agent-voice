/**
 * agent-voice — hands-free voice output for pi.
 *
 * Policy (approved 2026-09-11, evidence in README):
 *   - opt-in: both features default OFF
 *   - manual `speak` tool: word budget enforced IN THE TOOL (45 soft / 60 hard)
 *   - auto-announce: needs-input > failure > long-completion (>=120s); short successes silent
 *   - stoppable playback (WCAG 1.4.2); AGENT_VOICE_OFF=1 kill switch
 *
 * Modules:
 *   config.ts   — config resolution (env kill > session state > project > global > defaults)
 *   speak.ts    — speak tool + playback manager (non-blocking, stoppable)
 *   policy.ts   — trigger matrix for auto-announce + model-facing guidelines
 *   voice-command.ts — /voice on|off|status|stop
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config";
import { registerSpeakTool, stopPlayback } from "./speak";
import { registerVoiceCommand } from "./voice-command";
import { registerAutoAnnounce } from "./policy";

export default function agentVoiceExtension(pi: ExtensionAPI) {
	// Per-session in-memory state. Reset on every session_start (pi rebinds
	// extensions on session replacement; do not rely on state surviving it).
	const sessionState: { enabled?: boolean } = {};

	pi.on("session_start", (_event, _ctx) => {
		// Session-level switches start unset (config decides) each session.
		sessionState.enabled = undefined;
	});

	const getConfig = (cwd: string) =>
		resolveConfig({ cwd, session: sessionState, env: process.env });

	registerSpeakTool(pi, getConfig);
	registerVoiceCommand(pi, {
		getConfig,
		setSessionEnabled: (v: boolean) => {
			sessionState.enabled = v;
		},
	});
	registerAutoAnnounce(pi, getConfig);

	pi.on("session_shutdown", (_event, _ctx) => {
		// Playback runs in detached process groups and would outlive this process;
		// if the user is leaving, the voice should stop with them.
		stopPlayback();
	});
}
