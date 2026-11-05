---
name: claude-code
description: >-
  Use when you need to run Claude Code from another agent (Codex or any
  shell-capable agent): hand it a task headlessly with `claude -p`, pick the
  model, effort and permission mode, capture its answer and session id as JSON,
  continue the session with `--resume`, run several Claude workers, or detect a
  turn that its safeguards stopped. Covers the harness only; for how to brief
  and judge a Claude 5 model, load `collaborate-with-claude-5`.
---

# Drive Claude Code CLI

Claude Code is a separate agent with its own tools, permissions, project memory
(`CLAUDE.md`) and session store. Headless mode (`-p`) runs one turn to
completion and exits. You talk to it through files: a brief on stdin, a JSON
result on stdout, and a session id for follow-ups.

Check the installed version before relying on a flag: `claude --help`.

## Start a task

```sh
D=<scratch dir outside the repo>
cd /path/to/repo && claude -p --model opus --effort high \
  --permission-mode acceptEdits --output-format json \
  < "$D/brief.md" > "$D/result.json" 2> "$D/log.txt"
jq -r .result "$D/result.json" > "$D/report.md"
jq -r .session_id "$D/result.json"
```

| Part                                   | Why                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd <dir>`                             | The working directory is the project root: it decides which `CLAUDE.md`, settings and skills load. Use `--add-dir` for extra directories.           |
| `--model <alias or id>`                | Aliases `fable`, `opus`, `sonnet` (and `haiku`) select the latest of each; a full id such as `claude-opus-5-5` pins one.                            |
| `--effort <level>`                     | `low`, `medium`, `high`, `xhigh`, `max`. Use `high` for design and review.                                                                          |
| `--permission-mode <mode>`             | `plan` (no edits), `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`. Headless runs cannot answer prompts; pick a mode that will not need one.  |
| `--allowedTools` / `--disallowedTools` | Narrow what it may run, e.g. `--disallowedTools "Bash(git commit *)" "Bash(git push *)"`.                                                           |
| `--output-format json`                 | One JSON object: `result`, `session_id`, `is_error`, `subtype`, `stop_reason`, `permission_denials`, `safety_stops`, `total_cost_usd`, `num_turns`. |
| stdin brief                            | Long briefs in an argument break on quoting.                                                                                                        |

Optional: `--max-budget-usd` caps spend, `--json-schema` constrains the final
answer, `--session-id <uuid>` sets the id up front (handy when you launch in the
background and want to record it before it ends), `--append-system-prompt` adds
standing rules, `--no-session-persistence` for throwaway runs.

Run long tasks in the background and wait for the process to exit. Do not poll
in a loop. `--bg` starts a managed background session instead (`claude agents`,
`claude logs <id>`, `claude stop <id>`).

## Continue a session

```sh
cd /path/to/same/repo && claude -p --resume "$id" --model opus --effort high \
  --permission-mode acceptEdits --output-format json \
  < "$D/followup.md" > "$D/result-2.json" 2> "$D/log-2.txt"
```

- Resume from the same directory; sessions are stored per project path.
- Pass model, effort and permission mode again.
- `--fork-session` with `--resume` branches a copy instead of extending it.
- Resume the worker that did the work for follow-ups; start fresh for an
  independent review.

## Check the outcome

1. `is_error` false and `subtype` `success`. Otherwise read `log.txt`.
2. `permission_denials` non-empty: it wanted something the mode did not allow.
   Decide whether to widen the mode or rescope the task.
3. `safety_stops` non-empty, or a result saying the model's safeguards flagged
   the message: the turn was stopped, not answered. Do not resend the same
   brief. Rephrase around the actual goal, split out the part that tripped it,
   or do that part yourself (see `collaborate-with-claude-5`).
4. Read `git status` / `git diff` in its working tree; the report describes
   intent, the diff is what happened. Run the checks yourself.

## Run other models

Claude Code also hosts non-Claude models, such as GLM-5 and Qwen 3, through
Anthropic-compatible endpoints. Set the endpoint and map the model tiers in the
environment of that run only, so your own sessions are untouched:

```sh
ANTHROPIC_BASE_URL=<vendor endpoint> ANTHROPIC_AUTH_TOKEN="$VENDOR_KEY" \
ANTHROPIC_DEFAULT_OPUS_MODEL=<model> ANTHROPIC_DEFAULT_SONNET_MODEL=<model> \
ANTHROPIC_DEFAULT_HAIKU_MODEL=<small model> API_TIMEOUT_MS=3000000 \
  claude -p --model opus --output-format json < "$D/brief.md" > "$D/result.json"
```

- Map all three tiers explicitly; Claude Code picks tiers internally (for
  subagents and summaries) and a missing mapping sends those calls to a model
  name the endpoint does not know.
- `--effort` is passed through and mapped by the vendor; check its docs for what
  each level becomes.
- Claude-specific features (safeguard fields, some beta tools) may be absent or
  behave differently. Check `is_error` and the diff, not only `result`.
- The key is the user's; ask before using it.

| Model family     | `ANTHROPIC_BASE_URL`                                                                                                                                       | Tier models (opus / sonnet / haiku)                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| GLM-5 (Z.ai)     | `https://api.z.ai/api/anthropic` (China: `https://open.bigmodel.cn/api/anthropic`)                                                                         | `glm-5.3[1m]` / `glm-5.3[1m]` / `glm-5.3-flash[1m]` |
| Qwen 3 (Alibaba) | Token Plan: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`; Coding Plan: `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic` | `qwen3.8-max` / `qwen3.8-flash` / `qwen3.6-flash`   |

The Qwen URL ends in `/apps/anthropic` with no `/v1`, and a key from a different
plan returns 401. Neither endpoint lists models, so name them explicitly. Which
member to pick and how to work with it is in `collaborate-with-glm-5` and
`collaborate-with-qwen-3`.

## Parallel workers and isolation

The same rules as for any agent that edits files: one scope per worker, never
two workers on the same files, no commits from workers. When your own checkout
has uncommitted work, give Claude a separate detached worktree seeded with that
work (the `codex` skill ships `scripts/isolate.sh` for this) and run it with
`cd` into that worktree.

## Failure modes

| Symptom                            | Cause / fix                                                               |
| ---------------------------------- | ------------------------------------------------------------------------- |
| Hangs or stops early with denials  | Permission mode needs a prompt nobody can answer. Choose a mode up front. |
| Resume says no such session        | Different working directory than the original run.                        |
| Ignores project conventions        | Started outside the repo root, so `CLAUDE.md` did not load.               |
| Empty `result`, `safety_stops` set | Safeguard stop. Rephrase or reroute that part; do not retry verbatim.     |
| Cost or turns run away             | Add `--max-budget-usd`; narrow the scope in the brief.                    |
