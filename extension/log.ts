/**
 * Structured logging seam.
 *
 * One sink for the whole extension: pino writing newline-delimited JSON to
 * stderr. Every record carries a UTC ISO timestamp, a level name, the
 * `component` binding, and a `correlationId` supplied by the caller, so a
 * spoken announcement can be followed across spawn, exit, and cancel.
 *
 * Levels are diagnosis, not user output. pi does not redirect extension
 * stderr: it is the terminal the TUI is drawing on, so the default is `warn`
 * (a failure the user should know about) and `info`/`debug` are opt-in through
 * `AGENT_VOICE_LOG`, or the older `AGENT_VOICE_DEBUG=1` for `debug`.
 * Announcement text is never logged; the redaction paths are a second line of
 * defence for fields that would otherwise carry user content.
 */
import pino, { type Logger } from "pino";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: readonly LogLevel[] = [
	"silent",
	"error",
	"warn",
	"info",
	"debug",
];

function isLevel(value: string): value is LogLevel {
	return (LEVELS as readonly string[]).includes(value);
}

export function levelFromEnv(env: NodeJS.ProcessEnv): LogLevel {
	const configured = (env.AGENT_VOICE_LOG ?? "").toLowerCase();
	if (isLevel(configured)) return configured;
	return env.AGENT_VOICE_DEBUG === "1" ? "debug" : "warn";
}

export interface Fields {
	/** Stable event name, e.g. "playback.spawn", "policy.nudge". */
	event: string;
	/** Ties every record of one announcement or notification together. */
	correlationId?: string;
	[key: string]: unknown;
}

export interface Log {
	debug(fields: Fields): void;
	info(fields: Fields): void;
	warn(fields: Fields): void;
	error(fields: Fields): void;
	/** Bind fields (a correlation id) for every later record. */
	child(bindings: { correlationId: string }): Log;
}

/**
 * A failed write is swallowed on purpose: the sink is diagnostics, and losing a
 * record must never take down the session that was only trying to log. There is
 * nowhere to report this failure without risking the same failure again.
 */
function safely(write: () => void): void {
	try {
		write();
	} catch {
		// unreportable by construction
	}
}

function bind(logger: Logger): Log {
	return {
		debug: (fields) => safely(() => logger.debug(fields)),
		info: (fields) => safely(() => logger.info(fields)),
		warn: (fields) => safely(() => logger.warn(fields)),
		error: (fields) => safely(() => logger.error(fields)),
		child: (bindings) => {
			try {
				return bind(logger.child(bindings));
			} catch {
				return silentLog();
			}
		},
	};
}

/** A logger that discards everything, used when the real sink is unusable. */
function silentLog(): Log {
	const noop = (): void => {};
	return { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLog() };
}

export function createLog(
	env: NodeJS.ProcessEnv = process.env,
	destination?: pino.DestinationStream,
): Log {
	try {
		return bind(buildLogger(env, destination));
	} catch {
		// Logging must never be the reason a session breaks: a host with no
		// usable stderr gets silence, not a failed extension load.
		return silentLog();
	}
}

/** The process-wide sink: one destination, shared by every module. */
export const log: Log = createLog();

function buildLogger(
	env: NodeJS.ProcessEnv,
	destination: pino.DestinationStream | undefined,
): Logger {
	const logger = pino(
		{
			level: levelFromEnv(env),
			base: { component: "agent-voice" },
			timestamp: pino.stdTimeFunctions.isoTime,
			formatters: { level: (label) => ({ level: label }) },
			redact: {
				paths: ["text", "*.text", "announcement", "*.announcement"],
				censor: "[redacted]",
			},
		},
		// Synchronous writes: an extension can be torn down at any moment, and a
		// lost last record is exactly the one worth having. Records are emitted
		// per announcement and per policy decision, never per token.
		destination ?? pino.destination({ dest: 2, sync: true }),
	);
	return logger;
}
