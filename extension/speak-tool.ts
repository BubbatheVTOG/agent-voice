/**
 * The `speak` tool: parameter schema, refusal/failure results, and the success
 * result that tells the model what actually happened.
 *
 * Budget enforcement lives with the tool because the cap is a property of the
 * tool contract, not of playback.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ConfigFor, VoiceConfig } from "./config.ts";
import {
	enforceBudget,
	getPlaybackStatus,
	speakText,
} from "./playback.ts";
import {
	SPEAK_PROMPT_GUIDELINES,
	SPEAK_PROMPT_SNIPPET,
	SPEAK_TOOL_DESCRIPTION,
} from "./announcement.ts";

const SPEAK_PARAMS = Type.Object({
	text: Type.String({
		description:
			"Announcement to speak aloud. Keep under 45 words; format: [status word] + what happened (one line) + where details live (file/path). " +
			"Never include logs, code, commands, or secrets. Longer text is truncated at the hard cap and the full text saved to a file.",
	}),
});

function refusal(reason: string) {
	return {
		content: [
			{ type: "text" as const, text: `Voice output not spoken: ${reason}` },
		],
		details: { played: false, reason },
	};
}

/** Why speech is unavailable, or null when it is available. */
function unavailableReason(cfg: VoiceConfig): string | null {
	if (cfg.envKill)
		return "AGENT_VOICE_OFF=1 is set (kill switch wins over all config).";
	if (!cfg.enabled)
		return "voice output is disabled (enable with /voice on or agentVoice.enabled in settings).";
	return null;
}

interface Announcement {
	keptWords: number;
	originalWords: number;
	truncated: boolean;
	fullTextPath: string | null;
	pid: number;
}

function successText(announcement: Announcement, cfg: VoiceConfig): string {
	let text =
		`Announcement playback started (${announcement.keptWords} words, ` +
		`voice=${cfg.voice}, speed=${cfg.speed}). It runs detached and is ` +
		`stoppable via /voice stop; if synthesis fails after startup, the ` +
		`error is recorded for /voice status (do not retry on that basis).`;
	if (announcement.truncated && announcement.fullTextPath) {
		text += ` Input exceeded the ${cfg.wordHardCap}-word hard cap: original was ${announcement.originalWords} words; full text saved to ${announcement.fullTextPath}.`;
		return text;
	}
	if (announcement.keptWords > cfg.wordBudget) {
		text += ` Note: exceeded the ${cfg.wordBudget}-word guidance (hard cap ${cfg.wordHardCap}).`;
	}
	return text;
}

export function registerSpeakTool(pi: ExtensionAPI, getConfig: ConfigFor): void {
	pi.registerTool({
		name: "speak",
		label: "Speak",
		description: SPEAK_TOOL_DESCRIPTION,
		promptSnippet: SPEAK_PROMPT_SNIPPET,
		promptGuidelines: SPEAK_PROMPT_GUIDELINES,
		parameters: SPEAK_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
			const unavailable = unavailableReason(cfg);
			if (unavailable) return refusal(unavailable);

			const enforced = enforceBudget(params.text, cfg);
			if (!enforced.text) {
				return refusal("no text to speak (input was empty or whitespace)");
			}
			const pid = speakText({
				text: enforced.text,
				voice: cfg.voice,
				speed: cfg.speed,
			});
			if (pid === null) {
				const failure = getPlaybackStatus().lastError;
				return refusal(
					`playback failed to start${failure ? `: ${failure.summary}` : "."}`,
				);
			}
			const announcement: Announcement = { ...enforced, pid };
			return {
				content: [{ type: "text", text: successText(announcement, cfg) }],
				details: {
					played: true,
					words: enforced.keptWords,
					truncated: enforced.truncated,
					fullTextPath: enforced.fullTextPath,
					pid,
				},
			};
		},
	});
}
