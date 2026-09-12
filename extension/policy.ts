/**
 * Auto-announce nudge (task: approved trigger matrix).
 *
 * Background job outcomes in pi arrive at the main session as messages that
 * natively wake the model. This hook is a safety net for the two ALWAYS-announce
 * classes (failure, needs-input): when enabled, it injects a short, hidden
 * policy reminder so the model calls `speak` per the approved structure.
 *
 * Deliberately NOT handled here: "long-completion" success — the extension
 * cannot reliably measure job duration, and the policy hands that judgment to
 * the model via the speak tool's description (>= 2 min, session-initiated).
 *
 * The hook never composes the announcement itself: the model writes the
 * summary, the speak tool enforces the hard word cap.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Trigger, VoiceConfig } from "./config";

const FAILURE_RE = /background task (has )?failed|task failed|run failed/i;
const NEEDS_INPUT_RE =
	/needs attention|needs (your )?input|awaiting (your )?(input|permission|approval)|waiting for (your |the user'?s )?(input|reply|permission)/i;

function extractText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((b) =>
				b &&
				typeof b === "object" &&
				"text" in b &&
				typeof (b as { text: unknown }).text === "string"
					? ((b as { text: string }).text as string)
					: "",
			)
			.join("\n");
	}
	return "";
}

export function classify(text: string): Trigger | null {
	if (FAILURE_RE.test(text)) return "failure";
	if (NEEDS_INPUT_RE.test(text)) return "needs-input";
	return null;
}

export function registerAutoAnnounce(
	pi: ExtensionAPI,
	getConfig: (cwd: string) => VoiceConfig,
): void {
	const notified = new Set<string>();

	pi.on("message_end", (event, ctx) => {
		const m = event.message as
			| { role?: string; id?: string; content?: unknown }
			| undefined;
		if (!m || m.role !== "user") return;
		const id = m.id ?? "";
		if (id && notified.has(id)) return;

		const text = extractText(m);
		const trigger = text ? classify(text) : null;
		if (!trigger) return;

		const cfg = getConfig(ctx.cwd);
		if (
			!cfg.enabled ||
			!cfg.autoAnnounce ||
			cfg.envKill ||
			!cfg.announceOn.includes(trigger)
		)
			return;
		if (id) notified.add(id);

		// Hidden policy nudge: rides the wake the completion message itself
		// triggers (no extra turn), lands in context before the next model call.
		pi.sendMessage(
			{
				customType: "agent-voice-policy",
				content:
					`Voice policy: a job you initiated in this session just triggered "${trigger}". ` +
					`Call the speak tool now with a summary under 45 words: [status word] + what happened (one line) + where the details live (file/log path). ` +
					`Never read out logs, code, commands, or secrets. ` +
					`If you already announced this event, reply with exactly NO_REPLY instead. ` +
					`If voice output is disabled or the user just spoke to you, stay silent instead.`,
				display: false,
			},
			{ deliverAs: "followUp" },
		);
	});
}
