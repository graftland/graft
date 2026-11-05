---
name: codex
description: >-
  Use when you need to run OpenAI Codex CLI from another agent (Claude Code or
  any shell-capable agent): hand it a task with `codex exec`, run several Codex
  workers in parallel, continue a Codex session with `codex exec resume`, run
  `codex exec review`, capture its final report, or keep its edits from touching
  your uncommitted work. Covers the harness only; for how to brief and judge a
  GPT-6 model, load `collaborate-with-gpt-6`.
---

# Drive Codex CLI

Codex is a separate agent with its own tools, sandbox and session store. You
talk to it through files: a brief goes in on stdin, the final message comes out
through `-o`, and the session id lets you continue the same conversation later.

Check the installed version before relying on a flag: `codex exec --help`,
`codex exec resume --help`, `codex debug models` (JSON list of model slugs and
their reasoning levels).

## Start a task

```sh
D=<scratch dir outside the repo>
codex exec -m gpt-6-astra -c model_reasoning_effort="high" \
  -s danger-full-access -C /path/to/repo \
  -o "$D/report.md" - < "$D/brief.md" > "$D/log.txt" 2>&1
```

| Part                               | Why                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-m <slug>`                        | Pick the model explicitly; `~/.codex/config.toml` may default to another. See `codex debug models`, and `collaborate-with-gpt-6` for which member. |
| `-c model_reasoning_effort="high"` | Config defaults are often `low`/`medium`. Use `high` for design, review and bug hunting; `xhigh`/`max` for the hardest single task.                |
| `-s <mode>`                        | `read-only`, `workspace-write` or `danger-full-access`. The sandbox is the user's call; ask once and record it.                                    |
| `-C <dir>`                         | Working root. Point it at the worktree Codex should touch, not at your own checkout when you have uncommitted work.                                |
| `-o <file>`                        | Writes only the final message. This is the report you read; the log is for debugging.                                                              |
| `-` with `< brief.md`              | Read the prompt from a file. Long briefs in a shell argument break on quoting.                                                                     |
| `> log.txt 2>&1`                   | Keeps the event stream out of your context. The log contains the `session id:` line you need to resume.                                            |

Run it in the background (your harness's background-command feature, or `&` plus
a wait). A real task takes minutes to an hour. Do not poll the log in a loop;
wait for the process to exit, then read `report.md`.

Other useful flags: `--output-schema <file>` for a JSON-shaped final answer,
`--json` for a JSONL event stream, `--add-dir` for extra writable directories,
`--skip-git-repo-check` outside git, `--ephemeral` for throwaway runs that
should not be resumable.

## Continue a session

```sh
id=$(grep -m1 -i 'session id' "$D/log.txt" | awk '{print $NF}')
cd /path/to/same/worktree && codex exec resume "$id" \
  -m gpt-6-astra -c model_reasoning_effort="high" \
  -o "$D/report-2.md" - < "$D/followup.md" > "$D/log-2.txt" 2>&1
```

- `resume` has no `-s` or `-C`: it keeps the session's sandbox; `cd` into the
  same directory first. Pass `-m` and the effort again, or it falls back to
  config defaults.
- Prefer resuming the worker that did the work over starting a new one: it keeps
  everything it learned. Start fresh only when you want an independent view (see
  review below).
- `codex exec fork <id>` branches a session when two follow-ups should start
  from the same state.
- Record every session id with what it worked on (in your notes or memory).
  Sessions outlive your context window.

## Run workers in parallel

Give each worker one scope (package, directory, sample) and its own report file.
Write the shared background once and concatenate it with each scope:

```sh
cat "$D/shared.md" "$D/scope-a.md" > "$D/brief-a.md"
```

Two workers must never edit the same files. When they share one checkout, the
brief must say: edit only your scope; put new tests in new files; ignore type
errors in other scopes (someone else is mid-edit); never `git commit`, `stash`,
`checkout` or `reset`. Stronger: give each worker its own worktree (below) and
merge their diffs yourself.

## Isolate before Codex builds or tests

A "read-only" brief does not stop Codex from running builds. In one case a
review built a repro in `/tmp`, symlinked `node_modules` back into the worktree,
and the bundler's output clean followed the link and deleted uncommitted source.
Before handing over anything that may build, test or install while uncommitted
work exists:

```sh
# scripts/isolate.sh ships with this skill: it saves the patch and untracked
# files beside the destination, adds a detached worktree and applies them.
<skill-dir>/scripts/isolate.sh /path/to/repo "$D/wt-name"
```

Then run Codex with `-C "$D/wt-name"`, and add to the brief: no symlinks into
any other workspace, no builds in temp dirs that point back at the repo. When it
finishes, take its work back with `git -C "$D/wt-name" diff --binary` and apply
it to your tree after review. `--worktree` (Codex-managed worktree) is an
alternative when you do not need to seed it with uncommitted changes.

## Code review

`codex exec review --uncommitted`, `--base <branch>` or `--commit <sha>` runs
Codex's built-in review. For an adversarial review with your own focus, use
plain `codex exec` with a read-only brief instead: it lets you name the risk
areas, the evidence you want and the report shape.

For independent review, start a fresh session (not a resume) and do not give it
the history of earlier rounds; a reviewer that already knows your reasoning
tends to confirm it.

## Read the result

1. Read `report.md`, then `git status` / `git diff` in the worktree it used. The
   report describes intent; the diff is what happened.
2. Run the project's checks yourself. Do not relay "all tests pass" unchecked.
3. If the run failed or the report is empty, read the tail of `log.txt`.
4. Verify findings before passing them to the user, and say which ones you
   confirmed.

## Failure modes

| Symptom                              | Cause / fix                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Model or effort lower than asked     | `resume` without `-m`/`-c`; config defaults applied.                                          |
| Resume edits the wrong tree          | `resume` ignores `-C`; `cd` to the original root first.                                       |
| Uncommitted work vanished            | Build/clean through a symlink. Restore from the saved patch; isolate next time.               |
| Worker edited another worker's files | Scope not stated, or shared checkout. Separate worktrees.                                     |
| Report is fluent but unsupported     | Ask in the follow-up which points came from running or reading code, and which are inference. |
