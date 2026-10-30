/**
 * agent-voice — hands-free voice output for pi.
 *
 * Policy (approved 2026-09-11, evidence in README):
 *   - opt-in: both features default OFF
 *   - manual `speak` tool: word budget enforced IN THE TOOL (45 soft / 60 hard)
 *   - auto-announce: needs-input > failure > stopped > long-completion (>=120s)
 *   - stoppable playback (WCAG 1.4.2); AGENT_VOICE_OFF=1 kill switch
 *
 * Modules (each one owns a single concept):
 *   index.ts          — wiring only
 *   config.ts         — config resolution (env kill > session > project > global)
 *   availability.ts   — is the agent-say backend usable at all
 *   playback.ts       — spawn/stop/status of one announcement
 *   speak-tool.ts     — the `speak` tool: schema, budget, results
 *   policy.ts         — which job outcomes announce, and the hidden nudge
 *   voice-command.ts  — /voice on|off|status|stop and policy options
 *   announcement.ts   — the announcement contract, stated once
 *   log.ts            — structured logging seam
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULTS,
	resolveConfig,
	type ConfigFor,
	type Trigger,
	type VoiceConfig,
} from "./config.ts";
import { registerSpeakTool } from "./speak-tool.ts";
import { stopPlayback } from "./playback.ts";
import { registerVoiceCommand, type VoiceStatusContext } from "./voice-command.ts";
import { registerAutoAnnounce } from "./policy.ts";
import { resolveAgentSayBin } from "./availability.ts";

interface SessionState {
	enabled?: boolean;
	autoAnnounce?: boolean;
	longJobThresholdSec?: number;
	announceOn?: Trigger[];
}

function sessionState(): SessionState {
	// Session-level switches start unset (config decides) each session.
	return {
		enabled: undefined,
		autoAnnounce: undefined,
		longJobThresholdSec: undefined,
		announceOn: undefined,
	};
}

interface StatusStyle {
	color: string;
	label: string;
}

const BLOCKED_STYLE: StatusStyle = { color: "\u001b[38;2;255;209;102m", label: "VOICE BLOCKED" };
const ON_STYLE: StatusStyle = { color: "\u001b[38;2;114;214;160m", label: "VOICE ON" };
const OFF_STYLE: StatusStyle = { color: "\u001b[38;2;139;149;167m", label: "VOICE OFF" };

function statusStyle(cfg: VoiceConfig): StatusStyle {
	if (cfg.envKill) return BLOCKED_STYLE;
	if (cfg.enabled) return ON_STYLE;
	return OFF_STYLE;
}

export default function agentVoiceExtension(pi: ExtensionAPI) {
	if (!resolveAgentSayBin()) return;

	// Per-session in-memory state. Reset on every session_start (pi rebinds
	// extensions on session replacement; do not rely on state surviving it).
	let state: SessionState = sessionState();

	const getConfig: ConfigFor = (cwd, projectTrusted) =>
		resolveConfig({ cwd, session: state, env: process.env, projectTrusted });

	const publishStatus = (ctx: VoiceStatusContext): void => {
		const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
		const style = statusStyle(cfg);
		ctx.ui.setStatus("agent-voice", `${style.color}${style.label}\u001b[39m`);
	};

	const setSessionEnabled = (enabled: boolean): void => {
		state.enabled = enabled;
		state.autoAnnounce = enabled;
		if (!enabled) return;
		// `/voice on` is the safe, predictable opt-in: reset policy overrides to
		// the documented built-in defaults for this session.
		state.longJobThresholdSec = DEFAULTS.longJobThresholdSec;
		state.announceOn = [...DEFAULTS.announceOn];
	};

	const autoAnnounce = registerAutoAnnounce(pi, getConfig);

	pi.on("session_start", (_event, ctx) => {
		state = sessionState();
		autoAnnounce.reset();
		publishStatus(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		publishStatus(ctx);
	});

	registerSpeakTool(pi, getConfig);
	registerVoiceCommand(pi, {
		getConfig,
		setSessionEnabled,
		setSessionPolicy: (policy) => {
			if (policy.longJobThresholdSec !== undefined) {
				state.longJobThresholdSec = policy.longJobThresholdSec;
			}
			if (policy.announceOn !== undefined) state.announceOn = policy.announceOn;
			if (policy.autoAnnounce !== undefined) {
				state.autoAnnounce = policy.autoAnnounce;
			}
		},
		publishStatus,
	});

	pi.on("session_shutdown", () => {
		// Playback runs in detached process groups and would outlive this process;
		// if the user is leaving, the voice should stop with them.
		stopPlayback();
	});
}
