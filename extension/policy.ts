/**
 * Auto-announce nudge (task: approved trigger matrix).
 *
 * Background job outcomes in pi arrive at the main session as custom messages
 * that natively wake the model. This hook injects a short, hidden policy
 * reminder so the model calls `speak` per the approved structure.
 *
 * Successful completions are candidates, not guaranteed announcements: the
 * model decides whether the job was long or substantial. The runtime threshold
 * is supplied as guidance because this extension cannot measure every task's
 * start time.
 *
 * The hook never composes the announcement itself: the model writes the
 * summary, the speak tool enforces the hard word cap.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Trigger, VoiceConfig } from "./config";

const FAILURE_RE = /background task (has )?failed|task failed|run failed/i;
const NEEDS_INPUT_RE =
	/needs attention|needs (your )?input|awaiting (your )?(input|permission|approval)|waiting for (your |the user'?s )?(input|reply|permission)/i;
const COMPLETION_RE =
	/^(?:background task|detached foreground task) completed:/i;

function debug(reason: string): void {
	if (process.env.AGENT_VOICE_DEBUG === "1")
		console.error(`[agent-voice] policy ${reason}`);
}

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
	if (COMPLETION_RE.test(text)) return "long-completion";
	return null;
}

export function registerAutoAnnounce(
	pi: ExtensionAPI,
	getConfig: (cwd: string, projectTrusted: boolean) => VoiceConfig,
): void {
	const notified = new Set<string>();
	const taskUpdateArgs = new Map<string, { taskId?: string; status?: string }>();

	const nudge = (
		trigger: Trigger,
		cfg: VoiceConfig,
		key: string,
	): void => {
		if (
			!cfg.enabled ||
			!cfg.autoAnnounce ||
			cfg.envKill ||
			!cfg.announceOn.includes(trigger)
		)
			return;
		if (notified.has(key)) {
			debug("ignored duplicate completion");
			return;
		}
		notified.add(key);
		debug(`nudging ${trigger}`);

		// Hidden policy nudge: rides the wake the completion itself triggers
		// (no extra turn), lands in context before the next model call.
		pi.sendMessage(
			{
				customType: "agent-voice-policy",
				content:
					`Voice policy: a job you initiated in this session just triggered "${trigger}". ` +
					(trigger === "long-completion"
						? `This is only a candidate: speak only if it was long (about ${cfg.longJobThresholdSec} seconds or more) or a substantial user-requested task; otherwise stay silent. `
						: "") +
					`Call the speak tool now with a summary under 45 words: [status word] + what happened (one line) + where the details live (file/log path). ` +
					`Never read out logs, code, commands, or secrets. ` +
					`If you already announced this event, reply with exactly NO_REPLY instead. ` +
					`If voice output is disabled or the user just spoke to you, stay silent instead.`,
				display: false,
			},
			{ deliverAs: "followUp" },
		);
	};

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "TaskUpdate") return;
		const args = event.args as { taskId?: unknown; status?: unknown };
		taskUpdateArgs.set(event.toolCallId, {
			taskId: typeof args?.taskId === "string" ? args.taskId : undefined,
			status: typeof args?.status === "string" ? args.status : undefined,
		});
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "TaskUpdate") return;
		const args = taskUpdateArgs.get(event.toolCallId);
		taskUpdateArgs.delete(event.toolCallId);
		if (event.isError || args?.status !== "completed") return;
		const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
		nudge("long-completion", cfg, `task-update:${event.toolCallId}`);
	});

	pi.on("message_end", (event, ctx) => {
		const m = event.message as
			| { role?: string; id?: string; customType?: string; content?: unknown }
			| undefined;
		if (!m) return;
		const isTaskNotification = m.customType === "subagent-notify";
		if (m.role !== "user" && !isTaskNotification) {
			debug("ignored non-user/non-task message");
			return;
		}
		const id = m.id ?? "";
		if (id && notified.has(id)) {
			debug("ignored duplicate notification");
			return;
		}

		const text = extractText(m);
		const trigger = text ? classify(text) : null;
		if (!trigger) {
			debug("ignored unclassified notification");
			return;
		}
		debug(`recognized ${trigger}`);

		const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
		if (
			!cfg.enabled ||
			!cfg.autoAnnounce ||
			cfg.envKill ||
			!cfg.announceOn.includes(trigger)
		)
			return;
		nudge(trigger, cfg, id || `message:${text}`);
	});
}
