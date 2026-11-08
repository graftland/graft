# Phase 4: supervision, one change path, minimal development source

Status: specification, 2026-11-08. Written by Claude; GPT reviews once after all
phases. Controlling sources: `architecture.md` §5.1, §7, §8.2–8.3, §11;
`design/phase-3.md` and its proof for what exists.

## Commitments

- **Faults have an owner (C8).** A failed member or a crashed unit is retried by
  the supervisor under a bounded restart intensity, then isolated and reported.
- **One change path.** Every runtime change of a kernel deployment is a Change:
  supervisor restarts, Loader edits and development reloads included.
  `Graft.replace`, aliases, in-place `Update`, `ManagedFork` and the HMR reload
  engine are deleted.
- **Development without restarting the process (C9, minimal).**
  `graft start --watch` turns a saved config or module into a Change for the
  affected entries; other entries and their sessions keep running.

## Step 1: supervisor in the decision core

| Rule                                  | Behavior                                                                                                                                                           | Source                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Policy                                | Deployment data `supervision: { intensity, period }`, default 3 restarts in 60 000 ms. Encodable only; no plugin closure.                                          | A §7 bullets 1–2           |
| Counting                              | One entry per attempted restart, keyed by instance, kept across generations. `Busy`, planned generations and waiting for a dependency do not count.                | A §7 bullet 4              |
| Member failure, no owning Change      | Restart the member and its local consumers in their unit if the intensity allows; otherwise the instance is **escalated**: it stays failed, nothing else restarts. | A §7 table row 1, bullet 4 |
| Member failure while a Change owns it | Unchanged: the Change fails or recovers; the supervisor starts no competing attempt.                                                                               | A §7 table row 3           |
| Unit crash, no owning Change          | Settle the whole group, then submit one supervisor Change that deploys the group's established targets through ordinary admission. Counts once per member.         | A §7 table row 6, bullet 3 |
| `Busy`                                | The restart waits and is retried when the conflicting owner releases its reservations; it is never dropped.                                                        | A §7 dependency withdrawal |
| Missing exit evidence                 | No new execution competes for the same claim.                                                                                                                      | A §7 last table row        |
| Observation                           | `supervision` per instance in the public unit facts: recent attempts, escalated flag.                                                                              | A §9.1                     |

Non-goals: backoff delays (attempts are immediate, bounded by intensity),
escalation to an application supervisor, plugin-proposed policies.

## Step 2: Loader edits and the minimal development source

| Rule        | Behavior                                                                                                                                                                                              | Source          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Watch       | `graft start --watch` is accepted. The Loader unit watches the config file and each entry module's captured package directory (not `node_modules`, `.graft`, `.cache`). Edits within 100 ms coalesce. | A §8.3          |
| Candidate   | Each revision re-reads the file and re-captures modules into content-addressed artifacts, so a candidate's bytes never change while it is prepared.                                                   | A §8.3 bullet 1 |
| Diff        | Changed or new entries become `Deploy`, removed entries `Remove`, in one Change; unchanged entries are not touched.                                                                                   | A §5.1, §8.2    |
| Concurrency | While a Change from the Loader is in flight or rejected `Busy`, the newest revision is kept and submitted once the previous Change concludes. No edit is lost; no busy polling.                       | A §8.3 bullet 2 |
| Failure     | A failed revision is reported; the running entries stay as they are; the next save tries again.                                                                                                       | A §8.2 row 1    |
| Trial       | Development Changes use a zero trial.                                                                                                                                                                 | A §8.3 table    |

Non-goals: command edits with stored-version compare-and-swap through a public
Loader API (the file is the only editor in this phase); environment and secret
watching; warm Worker pools.

## Step 3: delete the second change path

Delete, with their tests, docs pages and sample uses, recorded in
`phase-4-deletion-manifest.md`:

- `Graft.replace`, `Graft.resolve`, `internal/replacement.ts`,
  `internal/aliases.ts`;
- `Plugin.Update` and in-place update handling; `Fork.update` becomes a member
  restart with the new configuration in the embedded mode;
- `Transition.ManagedFork`, `withUnmanaged`, `assertUnmanaged` and `unitGuard`
  mutation guards;
- the HMR package's in-process reload engine, `docs/replace.md`, `hmr-api.md`;
- samples that depend on `replace` are rewritten onto Changes or removed.

Embedded `Graft.plugin` composition keeps cooperative member restart; it makes
no kernel guarantee (A §1.3).

## Evidence and enough bar

Each step ships reducer tests for its rules, at least one native test, three
language docs for public behavior, and full checks (build, typecheck, test, docs
tests, treefmt, packed gateway). Enough when every rule above has a named test
and the deleted APIs no longer exist in any package, sample or doc.
