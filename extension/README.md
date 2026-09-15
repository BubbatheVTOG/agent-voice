# agent-voice — hands-free voice output for pi

Speaks short, hands-free announcements to the user via **local** Kokoro TTS
(`~/.local/bin/agent-say` — isolated in `~/.local/agent-say/`, no cloud, no API key).

**Everything is OFF by default.** Voice is the most intrusive notification
channel; both features are strictly opt-in.

## Layout

```
~/.pi/agent/extensions/agent-voice/
├── index.ts          # entry: wiring, per-session state
├── config.ts         # config resolution + provenance
├── speak.ts          # `speak` tool + playback manager + word-budget enforcement
├── policy.ts         # auto-announce nudge (failure / needs-input detection)
├── voice-command.ts  # /voice on|off|status|stop
└── README.md
```

TTS backend (separate, pre-existing): `~/.local/agent-say/` (venv + Kokoro-82M +
`bin/agent-say` + `install.sh`). This extension only drives that CLI.

## Features

1. **`speak` tool** — the model can speak a short announcement (non-blocking
   playback, stoppable).
2. **Auto-announce nudge** — when a background job the user initiated in this
   session **fails** or **needs the user's input/permission**, a hidden policy
   reminder is injected so the model calls `speak` with a compliant summary.
   Long-job *success* announcements are the model's judgment (its tool
   description carries the ≥2-minute policy) — the extension cannot reliably
   measure job duration.

## Turning it on

Precedence, highest wins:

| Layer | How | Scope |
| --- | --- | --- |
| Kill switch | `AGENT_VOICE_OFF=1` (env) | process; mutes everything incl. `/voice on` |
| Session | `/voice on` / `/voice off` and `/voice <option> <value>` | in-memory, this session only |
| Project | `agentVoice` in `<cwd>/.pi/settings.json` (trusted projects only) | project |
| Global | `agentVoice` in `~/.pi/agent/settings.json` | all projects |
| Defaults | both features `false` | — |

Minimal enable (global, manual speak only):

```json
{ "agentVoice": { "enabled": true } }
```

Full example (project-level):

```json
{
  "agentVoice": {
    "enabled": true,
    "autoAnnounce": true,
    "longJobThresholdSec": 120,
    "wordBudget": 45,
    "wordHardCap": 60,
    "voice": "af_aoede",
    "speed": 1.2,
    "announceOn": ["needs-input", "failure", "long-completion"]
  }
}
```

Invalid values in a higher layer are ignored and fall through to the next
lower layer (fail-closed; a malformed JSON file is treated as absent and
never crashes pi). For `announceOn` arrays, unknown trigger names are
dropped; a list containing no valid names falls through entirely instead of
silently disarming auto-announce.

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | manual `speak` tool usable |
| `autoAnnounce` | `false` | auto-announce nudge on job events |
| `longJobThresholdSec` | `120` | guidance for the model: "long" job boundary (informational — the model makes the judgment) |
| `wordBudget` | `45` | soft word target (advisory in the tool result) |
| `wordHardCap` | `60` | **hard** cap, enforced in the tool; clamps `wordBudget` from above (min 10) |
| `voice` | `af_aoede` | passed to `agent-say -v`; `agent-say --list-voices` for the 54 open voices |
| `speed` | `1.2` | passed to `agent-say -s` |
| `announceOn` | all three | which auto-announce triggers are armed: `needs-input`, `failure`, `long-completion` |

`/voice status` prints the resolved config with **per-key provenance**
(which layer set each value) — use it to debug "why is this on/off".

Runtime policy controls are session-scoped and take effect immediately:

```text
/voice autoAnnounce on|off
/voice threshold <seconds>
/voice announceOn needs-input,failure,long-completion
```

They do not modify settings files. Invalid values are rejected with a warning.

## Commands

| Command | Effect |
| --- | --- |
| `/voice on` | enable speech and auto-announce for this session, resetting policy to sane defaults (120s threshold and all triggers) |
| `/voice off` | disable speech and auto-announce for this session; other policy values are retained until the next `/voice on` or session reset |
| `/voice status` | resolved config + provenance + playing indicator + last TTS error (if any) |
| `/voice stop` | kill ALL running announcements (whole process groups: python wrapper **and** paplay) |
| `/voice autoAnnounce on\|off` | enable or disable automatic event nudges for this session |
| `/voice threshold <seconds>` | set the session’s long-job guidance threshold |
| `/voice announceOn <triggers>` | set comma-separated session triggers (`needs-input`, `failure`, `long-completion`) |

## The announcement policy (and why)

**Triggers** — announce only work the user initiated in this session:

1. **Needs the user's input/permission** → announce (highest priority)
2. **Failed or blocked** → announce
3. **Long-running (≥ ~2 min) completed** → announce a summary
4. **Substantial user-requested task completed with completion announcements enabled** → announce a concise summary
5. **Quick success, routine progress** → **silent. Always.**

**Structure** — `[status word] + what happened (one line) + where details
live (file/log path)`. Never read out logs, code, commands, or secrets.

**Budget** — 45-word target / 60-word hard cap. The cap is enforced **in the
tool, not the prompt**: over-long text is truncated at the cap and the full
text saved to `/tmp/agent-voice/voice-<ts>.txt` (0600); the tool tells the
model where. At 1.2× cadence the 60-word cap ≈ 20 s of audio.

**Evidence behind the policy** (researched 2026-09-11):

- *Interruption cost* — Gloria Mark (UCI), "The Cost of Interrupted Work":
  resuming interrupted work is the expensive part (the widely-cited ~23 min
  figure; secondary coverage is sloppier than the original — treat the exact
  number as indicative). Design consequence: announcements must be
  **ignorable** — absorb in a few seconds of peripheral hearing, no response
  demanded, details stay in files.
- *WCAG 1.4.2 (Level A)* — auto-playing audio > 3 s **must be pausable or
  independently volume-controllable**
  (<https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html>).
  Hence non-blocking playback + `/voice stop` (kills the whole process group).
- *GitHub Actions notifications* — opt-in, only runs **you** triggered,
  status-only, restrictable to failures-only
  (<https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs>).
  Source of: session-initiated scope, failure priority, "success of a quick
  job is the weak case — strip it out".
- *Claude Code* — announces when a task finishes **or is waiting for
  permission**, and **only when the user appears away**
  (<https://code.claude.com/docs/en/terminal-config>). Closest prior art to
  exactly this feature.
- *Nagios plugin guidelines* — "the entire output should fit in a pager
  message" (~80 chars ≈ 12–15 words for the status line); details behind a
  verbosity ladder (<https://nagios-plugins.org/doc/guidelines.html>).
  Source of: status-line density, details-as-a-file not details-as-speech.
- *PagerDuty alerting principles* — "an alert is something which requires a
  human to perform an action"; don't page what doesn't need action
  (<https://response.pagerduty.com/oncall/alerting_principles/>).
- *Spoken-notification length* — the only concrete budget in the wild is the
  phone-greeting/voicemail norm: 10–20 s, "shouldn't exceed 20 s" (vendor
  source, practical norm not a standard —
  <https://www.snaprecordings.com/blog/is-my-phone-system-messaging-too-long>).
  At ~180 wpm (1.2×): 20 s ≈ 60 words → the hard cap.

**Honest gaps**: no study quantifies passive (listen-only) vs
response-required interruption cost; no in-car TTS budget surfaced; several
length sources are vendor blogs. The policy is conservative against those gaps.

**Operational caveat**: the auto-announce classifier is pattern-based, so a
user *typing* "background task failed" in ordinary conversation can
false-fire the nudge. Mitigations: the nudge's own text ("if the user just
spoke to you, stay silent; if you already announced, reply NO_REPLY"), and
the model staying silent for ordinary conversation was observed in practice.

## How it works

- Each `speak` call spawns `agent-say -v <voice> -s <speed> -- <words>` as its
  own **detached process group** (`unref()`), so the model's turn is never
  blocked by playback, and **several announcements may be in flight at once** —
  the playback manager tracks every one of them, and `/voice stop` kills them
  all (`kill(-pid)` per group: python wrapper AND `paplay` child). Quitting a
  session stops any in-flight announcement too (`session_shutdown` hook). The
  `--` separator keeps option-like words in the spoken text (e.g. a quoted
  `-o`) from being parsed as CLI options.
- **Failed TTS is diagnosable, not silent.** Every spawn's stderr goes to a
  0600 file under `/tmp/agent-voice/`. Clean exits and user-stopped runs delete
  it; a failed run (missing voice, OOM, non-executable binary) keeps it and
  records a `lastError` that `/voice status` surfaces — and the `speak` tool
  result says "playback failed to start: …" instead of a fake success.
- The auto-announce hook watches real task notifications
  (`customType: "subagent-notify"`), `TaskUpdate` tool completions, and
  compatible user-role messages. It matches failure, needs-input, and
  successful-completion candidates. On a match — and only when enabled — it
  injects a hidden (`display: false`) policy reminder as a `followUp` message
  that rides the wake the completion message itself triggers. It does not
  compose the announcement (the model writes it; the tool enforces the
  budget). Successful completions remain model-filtered: quick tasks stay
  silent, while long or substantial tasks may be announced.
- Config is read live on every tool call / event (env kill switch included),
  so `export AGENT_VOICE_OFF=1` in your shell mutes pi started from it
  without any file edits.

## Verified (2026-09-11)

Headless (real `pi -p` + real TTS to the machine's speakers):

- default-off refusal; enabled path (audio played, non-blocking, confirm returned)
- `AGENT_VOICE_OFF=1` overrides everything
- hard-cap truncation (37→15 words; full text saved 0600; tool reports path)
- soft-budget advisory (45 < n ≤ 60 flags without truncating)
- config layering: 8 unit cases + invalid-value cascade + malformed-JSON fail-closed
  - untrusted-project layer skip + per-key provenance
- `classify()`: failure/needs-input positive; completion/greeting negative
- nudge E2E: simulated "Background task failed:" message → hidden nudge →
  model called `speak` ("Announced.")
- short-job success: model stayed silent (no `speak` call)
- stop E2E: two simultaneous announcements, both tracked (no orphaning),
  `stopPlayback` killed both groups, no stray `paplay`/`agent-say` left,
  no spurious error recorded, stderr logs cleaned up
- spawn failure: non-executable `AGENT_SAY_BIN` → `speak` returns
  "playback failed to start: … EACCES"; `lastError` recorded for /voice status
- extension loads clean in a real pi boot; LSP clean across all files
- audit E2E (2026-09-11): a finished announcement leaves the playback
  manager (status truthful, no stale entries, stderr cleaned); option-like
  spoken words (`-o PATH`) are spoken, never parsed as options; a user stop
  leaks no backend temp WAVs; all-unknown `announceOn` falls through instead
  of disarming

**Not yet exercised (needs a live interactive TUI session):**

- the `/voice` slash commands themselves (the underlying functions —
  stopPlayback, getPlaybackStatus, config resolution — are all verified
  headlessly; the command wiring has not been)
- a *real* failing background job and a *real* ≥2-minute job in-session
- needs-input on a real subagent (pattern coverage is best-effort)

## Extending

- **Different voice**: `agent-say --list-voices` (54 open Kokoro voices,
  downloaded on first use) → set `voice` in config, or pass `-v` per call
  from the CLI. Blending two voices is a one-flag change in `agent-say` if
  you ever want it.
- **Different backend**: the TTS call is a single `spawn` in `speak.ts`;
  `AGENT_SAY_BIN` env var overrides the binary path.
- **New trigger**: add a classifier in `policy.ts` + an entry in
  `VALID_TRIGGERS` in `config.ts` + a bullet in the `speak` tool description
  (the model's policy lives there — keep the three in lockstep).
- **Resident-server upgrade** (if 5 s cold start ever feels slow): run a
  persistent TTS server and change the `spawn` to an HTTP call; the tool's
  contract (budget, stop, config) is unchanged.
