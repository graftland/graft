# Phase 1 release migration evidence

The release worker changed only `packages/plugin-release/` and this evidence
file. No commits or external actions were made by the worker.

## Behavior

- Admission rejection stops forward dispatch and enters the existing reverse
  compensation path. It remains a `Rejected` observation, with no invented
  Change id or `Aborted` outcome.
- Compensation uses the actual instance version produced by the accepted Change.
  A later accepted Change makes compensation stale; the release becomes degraded
  and does not overwrite the later route.
- `Applied.outcomes` is an `Observation` union: `Admitted` carries the full
  outcome and its Change id; `Rejected` carries the full in-memory rejection.
  Durable and control summaries retain the id or rejection reason without
  serializing arbitrary causes or resolved inputs.
- `Options.policy` is removed in favor of `budget` and `requirements`.
- Desired Remote inputs retain their environment references. Initial startup,
  forward allocations, recovery and compensation go through the registration's
  resolver. Every allocation reads current values and validates the resolved
  configuration. Governed input keeps its existing prohibition on environment
  values and uses capability credential references.
- The plugin keeps serialized release execution. The production-admission test
  exercises independent direct Changes only to create a compensation conflict;
  it does not claim phase 5 batch guarantees.

## New tests

| File                 | Test                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `execution.test.ts`  | `compensates an accepted entry when the next request is rejected before admission`              |
| `execution.test.ts`  | `passes the accepted version to compensation and preserves a later accepted change on conflict` |
| `execution.test.ts`  | `uses production admission to reject B and fences compensation from a later accepted Change`    |
| `storage.test.ts`    | `replays admission rejection separately from admitted outcomes and failed compensation`         |
| `resolution.test.ts` | `resolves rotated references for recovery from the retained desired input`                      |

The first two tests failed against the previous executor because rejection
escaped the compensation fold. The journal test failed against the previous
replay because it required every entry to have an admitted outcome. The real
engine test uses production registration, admission, route commits and stale
version rejection. It observes allocations `old`, `next`, `later` and confirms
that stale compensation never allocates another `old` unit. The resolution test
observes separate initial, candidate and recovery credentials while the desired
input still contains its original `$env` reference.

## Checks and incidents

- `devenv shell -- pnpm typecheck`: passed after resolving the changed public
  types and adding explicit error conversion at the resolver and journal seam.
- `devenv shell -- pnpm vitest run --project @graftland/plugin-release`: 5
  files, 25 tests passed.
- `devenv shell -- pnpm --filter @graftland/plugin-release build`: passed.
- `devenv shell -- git diff --check -- packages/plugin-release`: passed.
- Intermediate checks found a missing test import and an extra closing
  parenthesis; both were corrected. The repository's automatic formatter also
  encountered a concurrent intermediate syntax error in a core test.
- The new production-admission test initially exposed `ReleaseInterrupted`
  during runtime teardown. The root worker fixed preparation cleanup ownership;
  the test passes without dropping or reclassifying the cause.
- The first new typecheck also saw the remote worker's intentionally failing
  metadata tests before its metadata implementation was written.

## Review focus

Review the `Observation` public shape and safe durable summaries, the exact
accepted version carried into compensation, and preservation of unresolved
inputs at the initial `Remote.plugin` boundary. Core cleanup and authorization
changes remain owned by the root worker. No unresolved release-specific blocker
is known after the listed checks.
