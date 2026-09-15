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
import { resolveConfig, type Trigger } from "./config";
import { registerSpeakTool, stopPlayback } from "./speak";
import { registerVoiceCommand, type VoiceStatusContext } from "./voice-command";
import { registerAutoAnnounce } from "./policy";

export default function agentVoiceExtension(pi: ExtensionAPI) {
	// Per-session in-memory state. Reset on every session_start (pi rebinds
	// extensions on session replacement; do not rely on state surviving it).
	const sessionState: {
		enabled?: boolean;
		autoAnnounce?: boolean;
		longJobThresholdSec?: number;
		announceOn?: Trigger[];
	} = {};

	const getConfig = (cwd: string, projectTrusted: boolean) =>
		resolveConfig({
			cwd,
			session: sessionState,
			env: process.env,
			projectTrusted,
		});

	const publishStatus = (ctx: VoiceStatusContext): void => {
		const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
		const color = cfg.envKill
			? "\u001b[38;2;255;209;102m"
			: cfg.enabled
				? "\u001b[38;2;114;214;160m"
				: "\u001b[38;2;139;149;167m";
		const label = cfg.envKill
			? "VOICE BLOCKED"
			: cfg.enabled
				? "VOICE ON"
				: "VOICE OFF";
		ctx.ui.setStatus("agent-voice", `${color}${label}\u001b[39m`);
	};

	pi.on("session_start", (_event, ctx) => {
		// Session-level switches start unset (config decides) each session.
		sessionState.enabled = undefined;
		sessionState.autoAnnounce = undefined;
		sessionState.longJobThresholdSec = undefined;
		sessionState.announceOn = undefined;
		publishStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		publishStatus(ctx);
	});

	registerSpeakTool(pi, getConfig);
	registerVoiceCommand(pi, {
		getConfig,
		setSessionEnabled: (v: boolean) => {
			sessionState.enabled = v;
			sessionState.autoAnnounce = v;
		},
		setSessionPolicy: (policy) => {
			if (policy.longJobThresholdSec !== undefined)
				sessionState.longJobThresholdSec = policy.longJobThresholdSec;
			if (policy.announceOn !== undefined)
				sessionState.announceOn = policy.announceOn;
			if (policy.autoAnnounce !== undefined)
				sessionState.autoAnnounce = policy.autoAnnounce;
		},
		publishStatus,
	});
	registerAutoAnnounce(pi, getConfig);

	pi.on("session_shutdown", (_event, _ctx) => {
		// Playback runs in detached process groups and would outlive this process;
		// if the user is leaving, the voice should stop with them.
		stopPlayback();
	});
}
