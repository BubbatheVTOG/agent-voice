/**
 * Structured logging seam.
 *
 * One sink for the whole extension: pino writing newline-delimited JSON to
 * stderr. Every record carries a UTC ISO timestamp, a level name, the
 * `component` binding, and a `correlationId` supplied by the caller, so a
 * spoken announcement can be followed across spawn, exit, and cancel.
 *
 * Levels are diagnosis, not user output: `debug` is off unless
 * `AGENT_VOICE_LOG=debug` (or the older `AGENT_VOICE_DEBUG=1`) is set.
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
	return env.AGENT_VOICE_DEBUG === "1" ? "debug" : "info";
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

function bind(logger: Logger): Log {
	return {
		debug: (fields) => logger.debug(fields),
		info: (fields) => logger.info(fields),
		warn: (fields) => logger.warn(fields),
		error: (fields) => logger.error(fields),
		child: (bindings) => bind(logger.child(bindings)),
	};
}

export function createLog(env: NodeJS.ProcessEnv = process.env): Log {
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
		// lost last record is exactly the one worth having.
		pino.destination({ dest: 2, sync: true }),
	);
	return bind(logger);
}
