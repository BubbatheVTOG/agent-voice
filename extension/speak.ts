/**
 * speak tool + playback manager.
 *
 * - Wraps ~/.local/bin/agent-say (local Kokoro TTS), non-blocking playback.
 * - Word budget enforced HERE (not in the prompt): hard cap truncates and
 *   saves the full text to a file the user can read.
 * - Stoppable: each announcement runs as its own process group; stopPlayback()
 *   kills ALL of them (python wrapper AND paplay child). WCAG 1.4.2.
 * - Diagnosable: every spawn's stderr is captured to a 0600 file; failed runs
 *   keep it and record a lastError surfaced by /voice status (clean runs and
 *   user-stopped runs clean up after themselves).
 */
import { spawn, type ChildProcess } from "node:child_process";
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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { VoiceConfig } from "./config";
import { resolveAgentSayBin } from "./availability.ts";

// ── playback manager (module scope; may hold several concurrent announcements) ──

interface ActivePlayback {
	pid: number;
	child: ChildProcess;
	stderrPath: string;
	/** true once either the error or exit handler has done its cleanup. */
	handled: boolean;
}

const active = new Set<ActivePlayback>();
/** pids we SIGTERM'd via /voice stop — their non-zero exit is not an error. */
const stoppedByUser = new Set<number>();

/** Disambiguates same-millisecond temp-file names (concurrent spawns). */
let fileSeq = 0;

export interface LastError {
	time: number;
	summary: string;
	stderrPath: string;
}
let lastError: LastError | null = null;

/**
 * Kill every running announcement (whole process groups, incl. paplay).
 * Returns how many groups were signalled.
 */
export function stopPlayback(): number {
	if (active.size === 0) return 0;
	let killed = 0;
	for (const p of active) {
		active.delete(p);
		stoppedByUser.add(p.pid);
		try {
			// detached: true => child is a process-group leader; negative pid kills the group.
			process.kill(-p.pid, "SIGTERM");
		} catch {
			try {
				p.child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
		}
		killed++;
	}
	return killed;
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
		/* stderr unreadable — summary is enough */
	}
	lastError = {
		time: Date.now(),
		summary: tail ? `${summary} — ${tail}` : summary,
		stderrPath,
	};
}

function tryUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		/* already gone */
	}
}

/**
 * Spawn one announcement. Returns the child pid (null if it never started).
 * Never throws for spawn failures — they are recorded via getPlaybackStatus().
 */
export function speakText(text: string, cfg: VoiceConfig): number | null {
	const bin = resolveAgentSayBin();
	if (!bin) {
		lastError = {
			time: Date.now(),
			summary:
				"agent-say is not an executable file (expected ~/.local/bin/agent-say or $AGENT_SAY_BIN).",
			stderrPath: "",
		};
		return null;
	}
	const dir = join(tmpdir(), "agent-voice");
	mkdirSync(dir, { recursive: true });
	const stderrPath = join(
		dir,
		`stderr-${Date.now()}-${process.pid}-${fileSeq++}.log`,
	);
	const fd = openSync(stderrPath, "w", 0o600);
	// "--" ends option parsing: option-like words in the spoken text (e.g.
	// a quoted "-o PATH") must be spoken, never executed as CLI options.
	const child = spawn(
		bin,
		["-v", cfg.voice, "-s", String(cfg.speed), "--", ...text.split(/\s+/)],
		{ detached: true, stdio: ["ignore", "ignore", fd] },
	);
	// We passed the fd to the child; close our own copy (documented pattern).
	closeSync(fd);
	// Only added to `active` when a real pid exists, so a -1 pid can never be
	// a kill target; the flag just coordinates the error/exit handlers below.
	const entry: ActivePlayback = {
		pid: child.pid ?? -1,
		child,
		stderrPath,
		handled: false,
	};
	child.on("error", (err) => {
		// spawn failed (ENOENT etc.) — the child never ran, nothing to kill.
		entry.handled = true;
		active.delete(entry);
		recordError(`failed to spawn agent-say: ${err.message}`, stderrPath);
		tryUnlink(stderrPath);
	});
	if (child.pid !== undefined) {
		active.add(entry);
		child.on("exit", (code, signal) => {
			// stopPlayback() already removed user-stopped entries from `active`
			// BEFORE their exit event fires — so membership is NOT the cleanup
			// signal; the `handled` flag is.
			if (entry.handled) return;
			entry.handled = true;
			// A finished announcement must leave the manager: `active` drives
			// isPlaying()/count, so a stale entry makes /voice status lie and
			// /voice stop count dead pids.
			active.delete(entry);
			if (stoppedByUser.has(entry.pid)) {
				stoppedByUser.delete(entry.pid);
				tryUnlink(stderrPath);
				return;
			}
			if (code === 0) {
				tryUnlink(stderrPath);
				return;
			}
			recordError(
				`agent-say exited code=${code} signal=${signal ?? "none"}`,
				stderrPath,
			);
		});
	}
	child.unref();
	return child.pid ?? null;
}

// ── word budget ──────────────────────────────────────────────────────────────

interface Enforced {
	text: string;
	originalWords: number;
	keptWords: number;
	truncated: boolean;
	fullTextPath: string | null;
}

/**
 * Hard cap enforcement. Truncated text is saved (0600) so nothing is lost —
 * the announcement points the user at the file instead of speaking more.
 */
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
	const dir = join(tmpdir(), "agent-voice");
	mkdirSync(dir, { recursive: true });
	const fullTextPath = join(
		dir,
		`voice-${Date.now()}-${process.pid}-${fileSeq++}.txt`,
	);
	writeFileSync(fullTextPath, raw, { mode: 0o600 });
	const kept = words.slice(0, cfg.wordHardCap).join(" ");
	return {
		text: kept,
		originalWords: words.length,
		keptWords: cfg.wordHardCap,
		truncated: true,
		fullTextPath,
	};
}

// ── tool registration ────────────────────────────────────────────────────────

const SPEAK_PARAMS = Type.Object({
	text: Type.String({
		description:
			"Announcement to speak aloud. Keep under 45 words; format: [status word] + what happened (one line) + where details live (file/path). " +
			"Never include logs, code, commands, or secrets. Longer text is truncated at the hard cap and the full text saved to a file.",
	}),
});

export function registerSpeakTool(
	pi: ExtensionAPI,
	getConfig: (cwd: string, projectTrusted: boolean) => VoiceConfig,
): void {
	pi.registerTool({
		name: "speak",
		label: "Speak",
		description:
			"Speak a short announcement aloud to the user via local TTS (hands-free; the user may not be at the keyboard). " +
			"WHEN TO USE — only when at least one is true for work YOU started in THIS session: " +
			"(1) it is waiting on the user (needs input or a permission decision); " +
			"(2) it failed or is blocked; " +
			"(3) a long-running job (roughly >= 2 minutes) has just completed; or " +
			"(4) a substantial user-requested task has just completed and completion announcements are enabled. " +
			"WHEN NOT TO USE — quick routine replies, progress updates, anything the user can read without a meaningful task boundary, and any work you did not initiate. " +
			"CONTENT — status word, one line of what happened, and where the details live (a file or log path). Under 45 words (hard limit 60; longer input is truncated and saved to a file whose path is returned). " +
			"Never read out logs, code, commands, or secrets. " +
			"The user can stop any announcement with /voice stop.",
		promptSnippet:
			"Speak short hands-free announcements via local TTS. Use for work you started this session that failed, is waiting on the user, is a long job (>=2min) that just completed, or is a substantial user-requested task that just completed with completion announcements enabled — never for routine replies. Under 45 words: [status] + what happened (one line) + where details live.",
		promptGuidelines: [
			"Use speak only for: work you initiated that needs the user's input, has failed, is a long-running job that just completed, or is a substantial user-requested task that just completed when completion announcements are enabled. Never for routine replies or progress updates.",
			"Keep speak announcements under 45 words: [status] + what happened (one line) + where details live. Never put logs, code, commands, or secrets in a speak announcement.",
		],
		parameters: SPEAK_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cfg = getConfig(ctx.cwd, ctx.isProjectTrusted());
			const refuse = (reason: string) => ({
				content: [
					{ type: "text" as const, text: `Voice output not spoken: ${reason}` },
				],
				details: { played: false, reason },
			});

			if (cfg.envKill)
				return refuse(
					"AGENT_VOICE_OFF=1 is set (kill switch wins over all config).",
				);
			if (!cfg.enabled)
				return refuse(
					"voice output is disabled (enable with /voice on or agentVoice.enabled in settings).",
				);

			const enforced = enforceBudget(params.text, cfg);
			if (!enforced.text) {
				return refuse("no text to speak (input was empty or whitespace)");
			}
			const pid = speakText(enforced.text, cfg);
			if (pid === null) {
				const fail = getPlaybackStatus().lastError;
				return refuse(
					`playback failed to start${fail ? `: ${fail.summary}` : "."}`,
				);
			}

			let text =
				`Announcement playback started (${enforced.keptWords} words, ` +
				`voice=${cfg.voice}, speed=${cfg.speed}). It runs detached and is ` +
				`stoppable via /voice stop; if synthesis fails after startup, the ` +
				`error is recorded for /voice status (do not retry on that basis).`;
			if (enforced.truncated && enforced.fullTextPath) {
				text += ` Input exceeded the ${cfg.wordHardCap}-word hard cap: original was ${enforced.originalWords} words; full text saved to ${enforced.fullTextPath}.`;
			} else if (enforced.keptWords > cfg.wordBudget) {
				text += ` Note: exceeded the ${cfg.wordBudget}-word guidance (hard cap ${cfg.wordHardCap}).`;
			}
			return {
				content: [{ type: "text", text }],
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
