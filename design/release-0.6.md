# 0.6.0: close every open item, then release

Started 2026-11-08 from `feat/architecture` (`5eb026c`). Claude and Sol
(GPT-6.1) implement in parallel worktrees and review each other's changes.
Sources in order: `architecture.md` (v1.0), `value.md`, the phase specs,
`review-fixes.md`, `CLAUDE.md`.

## Status (2026-11-09)

All items are merged into `release/0.6.0`; each has the tests named in its
acceptance column. Notable decisions while doing them:

- `graft start` had no way to declare the recording role; the kernel now accepts
  `declareRecording` once after start, and a graft.yml entry holds the role with
  `recording: { role, scope? }` (generic, no first-party path).
- `Committed` removals are refused for now: reconciling them needs the removed
  declaration.
- An interrupted Change from an earlier kernel run gets a concluding record with
  no outcome and phase `Interrupted`; the kernel does not resume it.
- Backoff defaults to no delay; down reasons take precedence `Revoked`,
  `Escalated`, `WaitingForDependency`, `RestartPending`.
- The package manager moved to pnpm 10 because Changesets 3 needs it.

## Work items

| Id  | Item                                                                                                                                                                                                                                                                | Architecture      | Owner  | Acceptance                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| K1  | `Committed` completion: commit and record the desired state without waiting for it to serve; the supervisor reconciles in its own Changes                                                                                                                           | §5.2              | Claude | Reducer tests: invalid targets never accepted as `Committed`; a later failure produces a separate supervisor Change linked to the committed id                     |
| K2  | Probes a plugin declares (`deployment.probes`) run by default; `requirements.probes` adds to them                                                                                                                                                                   | §5.2, §8.3        | Claude | A declared failing probe aborts or recovers a Change that names no probes                                                                                          |
| K3  | A revoked member no longer blocks restarting its authorized co-members of the same unit                                                                                                                                                                             | §9.3, §7          | Claude | Reducer test with two members, one revoked                                                                                                                         |
| K4  | Restart backoff from encodable parameters (exponential base, cap); a waiting restart counts once                                                                                                                                                                    | §7                | Claude | Reducer tests on timing and intensity                                                                                                                              |
| K5  | Status says why an instance is down: revoked, escalated, waiting for a dependency                                                                                                                                                                                   | §9.1              | Claude | Status projection tests; control protocol carries it                                                                                                               |
| K6  | Request keys and unfinished Changes survive a kernel restart: the recorder reports journaled keys and unconcluded Changes; the kernel answers repeated keys and records what it found for unfinished ones                                                           | §6.3              | Claude | Restart test with the durable recorder: same key and content returns the earlier record; an intent without a conclusion gets a concluding record with actual facts |
| R1  | Release workflow: `plan` / `apply` / `observe` / `rollback` / `history` over Changes, with recording                                                                                                                                                                | §8.1, §6          | Sol    | Native end-to-end test: apply, failing apply, rollback; rollback re-checks current policy; docs in three languages                                                 |
| R2  | Journal: diagnostics store with declared retention, and segment compaction                                                                                                                                                                                          | §9.2, §6.3        | Sol    | Tests for retention expiry, compaction preserving history, crash during compaction                                                                                 |
| L1  | Watch mode replans when the conflicting Change ends instead of polling every 250 ms; one integrated CLI + Loader + recorder + gateway test                                                                                                                          | §8.2, phase 3 bar | Sol    | Busy edit applied after the conflict without polling; integrated test drives `graft start` with recorder and gateway                                               |
| Q1  | Native addon in a Process unit (compiled N-API addon in test setup); benchmark failure on macOS; `group-native` flakiness under load; Linux-only failures from the Docker run                                                                                       | phase 6           | Sol    | Support matrix row "native addon" tested; full suite passes on macOS and in Linux Docker with `GRAFT_REQUIRE_SANDBOX=true`                                         |
| P1  | Changelog and release process modelled on Effect: Changesets (fixed group, `changelog-github`), a Version Packages pull request, per-package `CHANGELOG.md`, a GitHub Release per version from the changelog; the tag-driven npm publishing and its guarantees stay | owner request     | Sol    | Script tests; `changeset status`; workflows lint; `publishing.md` in three languages                                                                               |
| D1  | Notifications: amend `architecture.md` §4 to the pull direction with its reasons                                                                                                                                                                                    | §4                | Claude | Architecture and phase-7 agree                                                                                                                                     |

## Out of scope for 0.6.0

| Item                                                | Why                                          |
| --------------------------------------------------- | -------------------------------------------- |
| Real gateway with a design partner                  | Needs an external partner                    |
| Two independent authors adopting contracts          | Needs external authors                       |
| Server streams, state handoff, session continuation | Conditional extensions (§12), no trigger yet |

## Release

All items merged; full checks on macOS; full suite in Linux Docker; one
cross-review (Sol reviews Claude's work, Claude reviews Sol's); docs in three
languages; then merge to `main` with the 0.6.0 changeset and push; merge the
Version Packages pull request that Changesets opens; tag `v0.6.0` once `main`
passes CI; CI publishes to npm and creates the GitHub Release.
