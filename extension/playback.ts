/**
 * agent-say playback lifecycle.
 *
 * One announced sentence = one detached process group whose stderr goes to a
 * 0600 file, plus a request to the shared warm daemon (`--owner`, `--cancel`)
 * that may outlive the process. This module owns that state: what is playing,
 * what the user stopped, and the last failure.
 *
 * Two clocks are in play: wall clock for the recorded failure time, and the
 * monotonic `performance.now()` for durations, so a clock change cannot make a
 * spawn look like it took negative time.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { VoiceConfig } from "./config.ts";
import { resolveAgentSayBin } from "./availability.ts";
import { log } from "./log.ts";


interface ActivePlayback {
	/** -1 only when the spawn produced no pid; such an entry is never armed. */
	pid: number;
	child: ChildProcess;
	stderrPath: string;
	correlationId: string;
	startedAt: number;
	/** Coordinates the two terminal handlers; see finish(). */
	finished: boolean;
}

// Node runs these handlers on one event loop: the map/set mutations below are
// synchronous, so a stop cannot interleave inside an exit handler. What can
// double-fire is error-then-exit for the same entry, which `finished` absorbs.
const active = new Set<ActivePlayback>();
/** pids signalled by /voice stop — their non-zero exit is not a failure. */
const stoppedByUser = new Set<number>();

/** Disambiguates same-millisecond temp-file names (concurrent spawns). */
let fileSeq = 0;

/**
 * One owner token per extension process. The shared daemon scopes `--cancel`
 * to this token, so /voice stop here never silences another pi session.
 */
const OWNER = randomUUID();

export interface LastError {
	time: number;
	summary: string;
	stderrPath: string;
}
let lastError: LastError | null = null;

export interface StopResult {
	/** Process groups that were signalled. */
	signalled: number;
	/** The shared daemon acknowledged a cancel for this owner. */
	cancelled: boolean;
}

/** Runtime scratch directory, created on demand. */
export function runtimeDir(): string {
	const dir = join(tmpdir(), "agent-voice");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Unique temp path: pid + sequence keep concurrent children apart. */
export function tempName(prefix: string, extension: string): string {
	return join(
		runtimeDir(),
		`${prefix}-${Date.now()}-${process.pid}-${fileSeq++}.${extension}`,
	);
}

function killGroup(entry: ActivePlayback): void {
	try {
		// detached: true => the child leads its process group; a negative pid
		// signals the group (python wrapper AND paplay).
		process.kill(-entry.pid, "SIGTERM");
	} catch {
		try {
			entry.child.kill("SIGTERM");
		} catch {
			// Already gone: the exit handler still runs its cleanup.
		}
	}
}

/**
 * Stop every announcement. The daemon plays outside the process group, so it
 * is always asked to cancel too — a group that already exited is exactly the
 * case where its audio is still playing.
 */
export function stopPlayback(): StopResult {
	const entries = [...active];
	active.clear();
	for (const entry of entries) stoppedByUser.add(entry.pid);
	for (const entry of entries) killGroup(entry);
	const cancelled = cancelDaemonPlayback();
	return { signalled: entries.length, cancelled };
}

/** Best-effort: never starts the daemon, never throws, bounded wait. */
function cancelDaemonPlayback(): boolean {
	const bin = resolveAgentSayBin();
	if (bin === null) return false;
	const startedAt = performance.now();
	try {
		const result = spawnSync(bin, ["--owner", OWNER, "--cancel"], {
			timeout: 500,
			stdio: "ignore",
		});
		const acknowledged = result.status === 0;
		log.info({
			event: "playback.cancel",
			outcome: acknowledged ? "ok" : "failed",
			status: result.status,
			elapsedMs: Math.round(performance.now() - startedAt),
		});
		return acknowledged;
	} catch (error) {
		log.warn({
			event: "playback.cancel",
			outcome: "error",
			summary: error instanceof Error ? error.message : String(error),
			elapsedMs: Math.round(performance.now() - startedAt),
		});
		return false;
	}
}

export function isPlaying(): boolean {
	return active.size > 0;
}

export function getPlaybackStatus(): {
	playing: boolean;
	count: number;
	lastError: LastError | null;
} {
	return { playing: isPlaying(), count: active.size, lastError };
}

/** Record a failed spawn/exit so /voice status can surface it. */
function recordError(summary: string, stderrPath: string): void {
	let tail = "";
	try {
		tail = readFileSync(stderrPath, "utf8")
			.trim()
			.split("\n")
			.slice(-2)
			.join(" | ");
	} catch {
		// Unreadable stderr: the summary alone still identifies the failure.
	}
	lastError = {
		time: Date.now(),
		summary: tail ? `${summary} — ${tail}` : summary,
		stderrPath,
	};
}

function clearError(): void {
	lastError = null;
}

function tryUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}

function exitOutcome(stopped: boolean, code: number | null): string {
	if (stopped) return "stopped";
	return code === 0 ? "ok" : "failed";
}

/** Removes every trace of a finished announcement. Idempotent. */
function finish(entry: ActivePlayback, event: string, fields: Record<string, unknown>): void {
	if (entry.finished) return;
	entry.finished = true;
	active.delete(entry);
	log.debug({
		event,
		correlationId: entry.correlationId,
		pid: entry.pid === -1 ? undefined : entry.pid,
		elapsedMs: Math.round(performance.now() - entry.startedAt),
		...fields,
	});
}

export interface SpeakRequest {
	text: string;
	voice: string;
	speed: number;
}

/**
 * Spawn one announcement. Returns the child pid (null when it never started).
 * Spawn failures are recorded, never thrown: the tool reports them.
 */
export function speakText(request: SpeakRequest): number | null {
	const bin = resolveAgentSayBin();
	if (!bin) {
		lastError = {
			time: Date.now(),
			summary:
				"agent-say is not an executable file (expected ~/.local/bin/agent-say or $AGENT_SAY_BIN).",
			stderrPath: "",
		};
		log.warn({ event: "playback.spawn", outcome: "no-backend" });
		return null;
	}

	const words = request.text.split(/\s+/).filter(Boolean);
	const stderrPath = tempName("stderr", "log");
	const fd = openSync(stderrPath, "w", 0o600);
	const correlationId = randomUUID();
	const startedAt = performance.now();
	let child: ChildProcess;
	try {
		child = spawn(
			bin,
			[
				"--owner",
				OWNER,
				"-v",
				request.voice,
				"-s",
				String(request.speed),
				// "--" ends option parsing: option-like words in the spoken text
				// (e.g. a quoted "-o PATH") must be spoken, never executed.
				"--",
				...words,
			],
			{ detached: true, stdio: ["ignore", "ignore", fd] },
		);
	} catch (error) {
		const summary = error instanceof Error ? error.message : String(error);
		recordError(`failed to spawn agent-say: ${summary}`, stderrPath);
		log.error({
			event: "playback.spawn",
			correlationId,
			outcome: "error",
			summary,
			elapsedMs: Math.round(performance.now() - startedAt),
		});
		return null;
	} finally {
		// We passed the fd to the child when spawn succeeded; either way, close
		// our own copy so a synchronous failure cannot leak a descriptor.
		closeSync(fd);
	}

	const entry: ActivePlayback = {
		pid: child.pid ?? -1,
		child,
		stderrPath,
		correlationId,
		startedAt,
		finished: false,
	};
	log.info({
		event: "playback.spawn",
		correlationId,
		outcome: "started",
		pid: child.pid,
		words: words.length,
		voice: request.voice,
		speed: request.speed,
		elapsedMs: Math.round(performance.now() - startedAt),
	});

	child.on("error", (error) => {
		// The child never ran, so there is nothing to kill.
		finish(entry, "playback.exit", { outcome: "spawn-error", code: null, signal: null });
		stoppedByUser.delete(entry.pid);
		recordError(`failed to spawn agent-say: ${error.message}`, stderrPath);
		log.error({
			event: "playback.spawn",
			correlationId,
			outcome: "error",
			summary: error.message,
			elapsedMs: Math.round(performance.now() - startedAt),
		});
	});

	if (child.pid !== undefined) {
		active.add(entry);
		child.on("exit", (code, signal) => {
			// stopPlayback() removes entries BEFORE their exit fires, so
			// membership is not the cleanup signal; finished is.
			const stopped = stoppedByUser.delete(entry.pid);
			finish(entry, "playback.exit", {
				outcome: exitOutcome(stopped, code),
				code,
				signal,
			});
			if (stopped || code === 0) {
				tryUnlink(stderrPath);
				clearError();
				return;
			}
			recordError(`agent-say exited code=${code} signal=${signal ?? "none"}`, stderrPath);
			log.warn({
				event: "playback.exit",
				correlationId,
				outcome: "failed",
				code,
				signal,
				stderrPath,
			});
		});
	}
	child.unref();
	return child.pid ?? null;
}

/** Hard-cap enforcement: truncated text is saved (0600) so nothing is lost. */
export interface Enforced {
	text: string;
	originalWords: number;
	keptWords: number;
	truncated: boolean;
	fullTextPath: string | null;
}

export function enforceBudget(raw: string, cfg: VoiceConfig): Enforced {
	const words = raw.trim().split(/\s+/).filter(Boolean);
	if (words.length <= cfg.wordHardCap) {
		return {
			text: words.join(" "),
			originalWords: words.length,
			keptWords: words.length,
			truncated: false,
			fullTextPath: null,
		};
	}
	const fullTextPath = tempName("voice", "txt");
	writeFileSync(fullTextPath, raw, { mode: 0o600 });
	return {
		text: words.slice(0, cfg.wordHardCap).join(" "),
		originalWords: words.length,
		keptWords: cfg.wordHardCap,
		truncated: true,
		fullTextPath,
	};
}
