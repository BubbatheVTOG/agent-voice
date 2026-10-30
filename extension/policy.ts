/**
 * Auto-announce: which job outcomes deserve an announcement, and the hidden
 * policy nudge that asks the model to speak one.
 *
 * Who decides: the notice's own `details.runs[]` when it carries them — a
 * failed run, a paused or stopped one, and a completion at or above the
 * duration bar are settled here. A `TaskUpdate` tick counts only when this
 * hook watched the task run for at least `longJobThresholdSec`. Wording is the
 * fallback signal, and then only the headline is read.
 *
 * The hook never composes the announcement: the model writes the summary and
 * the `speak` tool enforces the word cap.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfigFor, Trigger, VoiceConfig } from "./config.ts";
import { SPEAK_GUIDANCE } from "./announcement.ts";
import { log } from "./log.ts";


const FAILURE_RE = /background tasks? (has )?failed|task failed|run failed/i;
const NEEDS_INPUT_RE =
	/needs attention|needs (your )?input|awaiting (your )?(input|permission|approval)|waiting for (your |the user'?s )?(input|reply|permission)/i;
const STOPPED_RE = /^(?:background|detached foreground) tasks? (?:stopped|paused)\b/i;
const COMPLETION_RE = /^(?:background|detached foreground) tasks? completed\b/i;

// Completions that land together describe one moment of work; announcing each
// would spend a model turn per notification. One nudge covers the burst.
const NUDGE_COOLDOWN_MS = 5_000;

// Announced notifications are remembered so a replayed message cannot nudge
// twice. A session can produce thousands, so the set keeps the newest keys.
const MAX_REMEMBERED = 256;

const RUN_STATUSES = new Set(["completed", "failed", "paused", "stopped"]);

export interface NoticeRun {
	status?: string;
	durationMs?: number;
}

export interface NoticeDecision {
	trigger: Trigger;
	/** Known only when the notice itself reported the run's duration. */
	durationMs?: number;
}

function headline(text: string): string {
	return (text.split("\n", 1)[0] ?? "").trim();
}

export function classify(text: string): Trigger | null {
	const line = headline(text);
	if (FAILURE_RE.test(line)) return "failure";
	if (NEEDS_INPUT_RE.test(line)) return "needs-input";
	if (STOPPED_RE.test(line)) return "stopped";
	if (COMPLETION_RE.test(line)) return "long-completion";
	return null;
}

function knownRuns(runs: NoticeRun[] | undefined): NoticeRun[] | undefined {
	if (!runs?.length) return undefined;
	const known = runs.filter(
		(run) => typeof run?.status === "string" && RUN_STATUSES.has(run.status),
	);
	return known.length > 0 ? known : undefined;
}

/**
 * Structured notice data wins over wording, so a completion whose summary text
 * mentions a failure is still a completion, and a short run stays silent
 * instead of asking the model to guess a duration it was never given.
 */
export function decideNotice(
	text: string,
	runs: NoticeRun[] | undefined,
	thresholdSec: number,
): NoticeDecision | null {
	const known = knownRuns(runs);
	if (!known) {
		const trigger = classify(text);
		return trigger ? { trigger } : null;
	}
	if (known.some((run) => run.status === "failed")) return { trigger: "failure" };
	if (known.some((run) => run.status === "paused" || run.status === "stopped")) {
		return { trigger: "stopped" };
	}

	const durations = known
		.map((run) => run.durationMs)
		.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	if (durations.length !== known.length) return { trigger: "long-completion" };
	const durationMs = Math.max(...durations);
	if (durationMs < thresholdSec * 1000) return null;
	return { trigger: "long-completion", durationMs };
}

export function isArmed(cfg: VoiceConfig, trigger: Trigger): boolean {
	return (
		cfg.enabled &&
		cfg.autoAnnounce &&
		!cfg.envKill &&
		cfg.announceOn.includes(trigger)
	);
}

/**
 * A task tick reports bookkeeping, not a job outcome. Only a run this hook
 * watched from `in_progress` has a duration to judge.
 */
export function completedTaskMs(job: {
	status: string | undefined;
	startedAt: number | undefined;
	now: number;
}): number | undefined {
	const { status, startedAt, now } = job;
	if (status !== "completed") return undefined;
	if (startedAt === undefined) return undefined;
	return now - startedAt;
}

export function cooldownElapsed(
	lastSentAt: number | undefined,
	now: number,
	cooldownMs = NUDGE_COOLDOWN_MS,
): boolean {
	return lastSentAt === undefined || now - lastSentAt >= cooldownMs;
}

function formatDuration(durationMs: number): string {
	const seconds = Math.floor(durationMs / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
}

function policyPrompt(
	trigger: Trigger,
	cfg: VoiceConfig,
	durationMs: number | undefined,
): string {
	const head = `Voice policy: a job you initiated in this session just triggered "${trigger}". `;
	if (trigger === "failure") {
		return `${head}The run failed: say what failed and where the details live. ${SPEAK_GUIDANCE}`;
	}
	if (trigger === "stopped") {
		return `${head}The run ended before finishing: say that it stopped and where its log lives. ${SPEAK_GUIDANCE}`;
	}
	if (durationMs !== undefined) {
		return `${head}It ran ${formatDuration(durationMs)}, past the ${cfg.longJobThresholdSec}s bar: announce it. ${SPEAK_GUIDANCE}`;
	}
	return `${head}This is only a candidate: speak only if it was long (about ${cfg.longJobThresholdSec} seconds or more) or a substantial user-requested task; otherwise stay silent. ${SPEAK_GUIDANCE}`;
}

interface NudgeState {
	notified: Set<string>;
	lastNudgeAt: Map<Trigger, number>;
}

function remember(state: NudgeState, key: string): void {
	state.notified.add(key);
	while (state.notified.size > MAX_REMEMBERED) {
		const oldest = state.notified.values().next().value;
		if (oldest === undefined) return;
		state.notified.delete(oldest);
	}
}

/** Claims the right to nudge: one nudge per event, one per burst. */
function claim(state: NudgeState, trigger: Trigger, key: string, now: number): boolean {
	if (state.notified.has(key)) {
		log.debug({ event: "policy.duplicate", correlationId: key });
		return false;
	}
	remember(state, key);
	if (!cooldownElapsed(state.lastNudgeAt.get(trigger), now)) {
		log.debug({ event: "policy.coalesced", trigger });
		return false;
	}
	state.lastNudgeAt.set(trigger, now);
	return true;
}

interface NoticeMessage {
	key: string;
	text: string;
	runs: NoticeRun[] | undefined;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block && typeof block === "object" && "text" in block
				? String((block as { text: unknown }).text ?? "")
				: "",
		)
		.join("\n");
}

/** A user message or a subagent completion notice, or null for everything else. */
function noticeMessage(raw: unknown): NoticeMessage | null {
	const message = raw as
		| {
				role?: string;
				id?: string;
				customType?: string;
				content?: unknown;
				details?: { runs?: NoticeRun[] };
		  }
		| undefined;
	if (!message) return null;
	if (message.role !== "user" && message.customType !== "subagent-notify") {
		log.debug({ event: "policy.ignored-message", role: message.role });
		return null;
	}
	const text = extractText(message.content);
	if (!text) return null;
	return {
		// The key doubles as a log correlation id, so it must never carry
		// message content: an id-less message gets its own opaque token.
		key: message.id ?? randomUUID(),
		text,
		runs: message.details?.runs,
	};
}

export interface AutoAnnounce {
	/** Drops session-scoped memory: a new session starts with a clean slate. */
	reset(): void;
}

export function registerAutoAnnounce(
	pi: ExtensionAPI,
	getConfig: ConfigFor,
): AutoAnnounce {
	const state: NudgeState = { notified: new Set(), lastNudgeAt: new Map() };
	const taskUpdateArgs = new Map<string, { taskId?: string; status?: string }>();
	const taskStartedAt = new Map<string, number>();

	const nudge = (
		decision: NoticeDecision,
		cfg: VoiceConfig,
		key: string,
	): void => {
		if (!isArmed(cfg, decision.trigger)) return;
		if (!claim(state, decision.trigger, key, Date.now())) return;
		log.info({
			event: "policy.nudge",
			trigger: decision.trigger,
			durationMs: decision.durationMs,
			correlationId: key,
		});
		// Hidden policy nudge: rides the wake the notification itself triggers,
		// so it lands in context before the next model call.
		pi.sendMessage(
			{
				customType: "agent-voice-policy",
				content: policyPrompt(decision.trigger, cfg, decision.durationMs),
				display: false,
			},
			{ deliverAs: "followUp" },
		);
	};

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "TaskUpdate") return;
		const args = event.args as { taskId?: unknown; status?: unknown };
		const taskId = typeof args?.taskId === "string" ? args.taskId : undefined;
		const status = typeof args?.status === "string" ? args.status : undefined;
		taskUpdateArgs.set(event.toolCallId, { taskId, status });
		if (taskId && status === "in_progress") {
			taskStartedAt.set(taskId, Date.now());
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== "TaskUpdate") return;
		const args = taskUpdateArgs.get(event.toolCallId);
		taskUpdateArgs.delete(event.toolCallId);
		const startedAt = args?.taskId ? taskStartedAt.get(args.taskId) : undefined;
		// A terminal update closes the timing window whether or not it
		// succeeded: keeping the start would measure a later attempt against it.
		if (args?.taskId && args.status !== "in_progress") {
			taskStartedAt.delete(args.taskId);
		}
		if (event.isError || !args) return;

		const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
		const durationMs = completedTaskMs({
			status: args.status,
			startedAt,
			now: Date.now(),
		});
		if (durationMs === undefined) return;
		if (durationMs < cfg.longJobThresholdSec * 1000) {
			log.debug({ event: "policy.task-short", durationMs });
			return;
		}
		nudge(
			{ trigger: "long-completion", durationMs },
			cfg,
			`task-update:${event.toolCallId}`,
		);
	});

	pi.on("message_end", (event, ctx) => {
		const notice = noticeMessage(event.message);
		if (!notice) return;
		const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
		const decision = decideNotice(notice.text, notice.runs, cfg.longJobThresholdSec);
		if (!decision) {
			log.debug({ event: "policy.ignored-notice", correlationId: notice.key });
			return;
		}
		nudge(decision, cfg, notice.key);
	});

	return {
		reset(): void {
			state.notified.clear();
			state.lastNudgeAt.clear();
			taskUpdateArgs.clear();
			taskStartedAt.clear();
			log.debug({ event: "policy.reset" });
		},
	};
}
