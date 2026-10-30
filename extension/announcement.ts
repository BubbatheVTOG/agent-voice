/**
 * What an announcement is, stated once.
 *
 * The `speak` tool description, its prompt guidance, and the auto-announce
 * nudge all describe the same contract; keeping the wording in one module is
 * what stops the three from drifting apart.
 */
export const ANNOUNCE_STRUCTURE =
	"[status word] + what happened (one line) + where the details live (file or log path)";

// Both numbers are defaults a user can change; the tool reports the effective
// limit in its result, so the prose must not claim a fixed cap.
export const ANNOUNCE_BUDGET =
	"Under 45 words (default hard limit 60; longer input is truncated and the full text saved to a file whose path is returned)";

export const ANNOUNCE_PROHIBITIONS =
	"Never read out logs, code, commands, or secrets.";

/** The nudge's instruction to the model, after a trigger fired. */
export const SPEAK_GUIDANCE =
	`Call the speak tool now with a summary under 45 words: ${ANNOUNCE_STRUCTURE}. ` +
	`${ANNOUNCE_PROHIBITIONS} ` +
	"If you already announced this event, reply with exactly NO_REPLY instead. " +
	"If voice output is disabled or the user just spoke to you, stay silent instead.";

/** When the `speak` tool may be used at all. */
export const SPEAK_TOOL_DESCRIPTION =
	"Speak a short announcement aloud to the user via local TTS (hands-free; the user may not be at the keyboard). " +
	"WHEN TO USE — only when at least one is true for work YOU started in THIS session: " +
	"(1) it is waiting on the user (needs input or a permission decision); " +
	"(2) it failed or is blocked; " +
	"(3) a long-running job (roughly >= 2 minutes) has just completed; or " +
	"(4) a substantial user-requested task has just completed and completion announcements are enabled. " +
	"WHEN NOT TO USE — quick routine replies, progress updates, anything the user can read without a meaningful task boundary, and any work you did not initiate. " +
	`CONTENT — ${ANNOUNCE_STRUCTURE}. ${ANNOUNCE_BUDGET}. ` +
	`${ANNOUNCE_PROHIBITIONS} ` +
	"The user can stop any announcement with /voice stop.";

export const SPEAK_PROMPT_SNIPPET =
	"Speak short hands-free announcements via local TTS. Use for work you started this session that failed, is waiting on the user, is a long job (>=2min) that just completed, or is a substantial user-requested task that just completed with completion announcements enabled — never for routine replies. Under 45 words: [status] + what happened (one line) + where details live.";

export const SPEAK_PROMPT_GUIDELINES = [
	"Use speak only for: work you initiated that needs the user's input, has failed, is a long-running job that just completed, or is a substantial user-requested task that just completed when completion announcements are enabled. Never for routine replies or progress updates.",
	"Keep speak announcements under 45 words (default; the configured budget wins): [status] + what happened (one line) + where details live. Never put logs, code, commands, or secrets in a speak announcement.",
];
