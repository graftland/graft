# Phase 2 deletion manifest

Status: step 1. This manifest records the disposition at this commit, not the
final Phase 2 acceptance. Retained legacy tests remain evidence for the existing
embedded/Phase 1 implementation only.

## Replaced model cases

| Original test                                                                                                                                             | Disposition | Evidence or remaining work                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/change-model.test.ts`: retains leased consumers in a Stuck conflict set while unrelated work completes                                | Deferred    | Local captured-service closure is rejected in Phase 2; closure is Phase 3. Independent Stuck isolation is covered by decision-core.test.ts. |
| `packages/core/test/change-model.test.ts`: reaches an outcome at the budget boundary for every bounded lease cleanup interleaving                         | Replaced    | change-model.test.ts: repeated exit, timer, failure, cancellation and shutdown exploration.                                                 |
| `packages/core/test/change-model.test.ts`: settles exited generations leases without claiming finalizer success                                           | Replaced    | decision-core.test.ts: settles only the exited unit leases and keeps cleanup separate.                                                      |
| `packages/core/test/change-model.test.ts`: waits for affected nonmember participants without a global barrier                                             | Replaced    | change-model-settlement.test.ts: partially installed view and view-token rejection.                                                         |
| `packages/core/test/change-model.test.ts`: preserves both patches in every interleaving from the same base                                                | Replaced    | change-model.test.ts: every causal shuffle of independent Changes.                                                                          |
| `packages/core/test/change-model.test.ts`: reserves complete conflict sets atomically across three competing changes                                      | Replaced    | change-model.test.ts: conflicting admission and shutdown in every causal order; decision-core.test.ts: atomic conflict set and absence ABA. |
| `packages/core/test/change-model.test.ts`: recovers only owned patches while an unrelated change commits                                                  | Replaced    | change-model.test.ts: exclusive recovery alongside unrelated commit.                                                                        |
| `packages/core/test/change-model.test.ts`: keeps Stuck local with constant admission and commit object probes                                             | Replaced    | change-model.test.ts: footprint with 0, 20 and 200 unrelated instances; decision-core.test.ts: local Stuck and exact late release.          |
| `packages/core/test/change-model.test.ts`: rejects stale plans including optional absence and absence ABA                                                 | Replaced    | decision-core.test.ts: atomic conflict set and absence ABA.                                                                                 |
| `packages/core/test/change-model.test.ts`: allows shared read premises while fencing their writer                                                         | Replaced    | change-model-settlement.test.ts: shared read premises and writer fencing.                                                                   |
| `packages/core/test/change-model.test.ts`: rejects acknowledgements with stale change generation or view identity                                         | Replaced    | decision-core.test.ts: stale, duplicate and reordered reports; change-model-settlement.test.ts: stale view and late original attempt.       |
| `packages/core/test/change-model.test.ts`: keeps generations resolution leases and publication cleanup independent                                        | Deferred    | Local captured-service dependency closure is Phase 3; per-unit exit lease conservation is covered by decision-core.test.ts.                 |
| `packages/core/test/change-model.test.ts`: requires deployment group and local lease consumer closure                                                     | Replaced    | decision-core.test.ts: rejects group and cross-unit local dependencies before execution. Supported group closure is Phase 3.                |
| `packages/core/test/change-model.test.ts`: distinguishes equal service keys in different realms                                                           | Deferred    | Binding identity/provenance acceptance belongs to step 4; string object ids in the core are opaque distinct keys.                           |
| `packages/core/test/change-model.test.ts`: does not self-preempt planned withdrawal and never swallows invalidation as Busy                               | Replaced    | change-model-settlement.test.ts: refreshed read premises; change-model.test.ts: lost owned version.                                         |
| `packages/core/test/change-model.test.ts`: enumerates invalidation cancellation acknowledgements and shutdown at every bounded position                   | Replaced    | change-model.test.ts: repeated-event exploration to depth four.                                                                             |
| `packages/core/test/change-model.test.ts`: settles every admitted change after shutdown across all submission interleavings                               | Replaced    | change-model.test.ts: conflicting admission/shutdown shuffles; decision-core.test.ts: closing admission and actual stopped outcome.         |
| `packages/core/test/change-model.test.ts`: treats cancellation after stopping old generations as recovery before route switch                             | Replaced    | decision-core.test.ts: old-changed before Stop and fresh recovery trial.                                                                    |
| `packages/core/test/change-model.test.ts`: refuses recovery after losing an owned version and preserves failure causes                                    | Replaced    | change-model.test.ts: lost owned version before recovery.                                                                                   |
| `packages/core/test/change-model.test.ts`: exposes counterexamples to snapshot replacement and fork-wide lease release                                    | Replaced    | decision-core.test.ts: reverse commit orders, per-unit lease conservation; independent assertions run after every explored transition.      |
| `packages/core/test/change-model-settlement.test.ts`: releases Stuck reservations after late settlement without changing the outcome                      | Replaced    | decision-core.test.ts: local Stuck, exact late release, immutable conclusion; change-model-settlement.test.ts: late original command cause. |
| `packages/core/test/change-model-settlement.test.ts`: keeps cleanup evidence monotonic when exit evidence is repeated                                     | Replaced    | decision-core.test.ts: repeated native exit is idempotent and leaves the original cleanup fact intact.                                      |
| `packages/core/test/change-model-settlement.test.ts`: detects absence presence absence with a monotonically increasing object version                     | Replaced    | decision-core.test.ts: absence ABA and conflict set.                                                                                        |
| `packages/core/test/change-model-settlement.test.ts`: reserves Restart capacity through old exit and recovery at the unit limit                           | Replaced    | decision-core.test.ts: Restart and exclusive recovery at maxUnits=1.                                                                        |
| `packages/core/test/change-adapter.test.ts`: drives Stuck isolation and late reservation release through production without changing the recorded outcome | Replaced    | decision-core.test.ts: local Stuck, exact late release, immutable conclusion; change-model-settlement.test.ts: late original command cause. |

## File inventory

Every case in an unchanged file below is retained at step 1. A retained file is
not a claim that its old mechanism satisfies the Phase 2 unit guarantee. Later
steps must update this inventory as the corresponding implementations are
deleted.

| Original test file                                              | Step 1 disposition                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/benchmarks/test/equivalence.test.ts`                  | Retained, all cases                                          |
| `packages/benchmarks/test/remote.test.ts`                       | Retained, all cases                                          |
| `packages/benchmarks/test/runner.test.ts`                       | Retained, all cases                                          |
| `packages/cli/test/check.test.ts`                               | Retained, all cases                                          |
| `packages/cli/test/command-install.test.ts`                     | Retained, all cases                                          |
| `packages/cli/test/command-loading.test.ts`                     | Retained, all cases                                          |
| `packages/cli/test/command-plugins.test.ts`                     | Retained, all cases                                          |
| `packages/cli/test/command-registry.test.ts`                    | Retained, all cases                                          |
| `packages/cli/test/env.test.ts`                                 | Retained, all cases                                          |
| `packages/cli/test/hmr-lifetimes.test.ts`                       | Retained, all cases                                          |
| `packages/cli/test/intercepts.test.ts`                          | Retained, all cases                                          |
| `packages/cli/test/protocol-output.test.ts`                     | Retained, all cases                                          |
| `packages/cli/test/schema-file.test.ts`                         | Retained, all cases                                          |
| `packages/cli/test/schema-refresh.test.ts`                      | Retained, all cases                                          |
| `packages/cli/test/schema.test.ts`                              | Retained, all cases                                          |
| `packages/cli/test/start-integration.test.ts`                   | Retained, all cases                                          |
| `packages/cli/test/watch-integration.test.ts`                   | Retained, all cases                                          |
| `packages/cli/test/watch.test.ts`                               | Retained, all cases                                          |
| `packages/core/test/activation-release.test.ts`                 | Retained, all cases                                          |
| `packages/core/test/ambient-lifecycle.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/ambient-resolution.test.ts`                 | Retained, all cases                                          |
| `packages/core/test/async-close.test.ts`                        | Retained, all cases                                          |
| `packages/core/test/background-tasks.test.ts`                   | Retained, all cases                                          |
| `packages/core/test/call-admission.test.ts`                     | Retained, all cases                                          |
| `packages/core/test/cancellation-causes.test.ts`                | Retained, all cases                                          |
| `packages/core/test/change-adapter.test.ts`                     | Deleted; adapter-only assertions, step 2 conformance pending |
| `packages/core/test/change-allocation.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/change-authorization.test.ts`               | Retained, all cases                                          |
| `packages/core/test/change-execution-lifetime.test.ts`          | Retained, all cases                                          |
| `packages/core/test/change-late-obligations.test.ts`            | Retained, all cases                                          |
| `packages/core/test/change-leases.test.ts`                      | Retained, all cases                                          |
| `packages/core/test/change-lifetime.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/change-model-settlement.test.ts`            | Replaced; case mapping above                                 |
| `packages/core/test/change-model.test.ts`                       | Replaced; case mapping above                                 |
| `packages/core/test/change-preparation.test.ts`                 | Retained, all cases                                          |
| `packages/core/test/change-recovery-overlap.test.ts`            | Retained, all cases                                          |
| `packages/core/test/change-request.test.ts`                     | Retained, all cases                                          |
| `packages/core/test/change-restart.test.ts`                     | Retained, all cases                                          |
| `packages/core/test/change-settlement.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/change-shutdown.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/change-terminal.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/change-total-budget.test.ts`                | Retained, all cases                                          |
| `packages/core/test/change.test.ts`                             | Retained, all cases                                          |
| `packages/core/test/cleanup-interruption.test.ts`               | Retained, all cases                                          |
| `packages/core/test/cleanup-results.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/close-completion.test.ts`                   | Retained, all cases                                          |
| `packages/core/test/cordis-scenarios.test.ts`                   | Retained, all cases                                          |
| `packages/core/test/definition-identity.test.ts`                | Retained, all cases                                          |
| `packages/core/test/dependency-cycles.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/event-cancellation-composition.test.ts`     | Retained, all cases                                          |
| `packages/core/test/event-claim.test.ts`                        | Retained, all cases                                          |
| `packages/core/test/event-immediate.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/event-interleavings.test.ts`                | Retained, all cases                                          |
| `packages/core/test/event-invocation-scope.test.ts`             | Retained, all cases                                          |
| `packages/core/test/event-order.test.ts`                        | Retained, all cases                                          |
| `packages/core/test/event-origin.test.ts`                       | Retained, all cases                                          |
| `packages/core/test/event-release-propagation.test.ts`          | Retained, all cases                                          |
| `packages/core/test/event-requirements.test.ts`                 | Retained, all cases                                          |
| `packages/core/test/event-settle.test.ts`                       | Retained, all cases                                          |
| `packages/core/test/event.test.ts`                              | Retained, all cases                                          |
| `packages/core/test/fork-local-state.test.ts`                   | Retained, all cases                                          |
| `packages/core/test/generation-ownership.test.ts`               | Retained, all cases                                          |
| `packages/core/test/handler-interruption.test.ts`               | Retained, all cases                                          |
| `packages/core/test/intercept-generation.test.ts`               | Retained, all cases                                          |
| `packages/core/test/interruption.test.ts`                       | Retained, all cases                                          |
| `packages/core/test/layer-context.test.ts`                      | Retained, all cases                                          |
| `packages/core/test/lifecycle.test.ts`                          | Retained, all cases                                          |
| `packages/core/test/load-dispose-transitions.test.ts`           | Retained, all cases                                          |
| `packages/core/test/log-context.test.ts`                        | Retained, all cases                                          |
| `packages/core/test/manifest.test.ts`                           | Retained, all cases                                          |
| `packages/core/test/observation-journal.test.ts`                | Retained, all cases                                          |
| `packages/core/test/once-release.test.ts`                       | Retained, all cases                                          |
| `packages/core/test/owned-scope.test.ts`                        | Retained, all cases                                          |
| `packages/core/test/parallel-cancellation.test.ts`              | Retained, all cases                                          |
| `packages/core/test/plugin-config.test.ts`                      | Retained, all cases                                          |
| `packages/core/test/plugin-declarations.test.ts`                | Retained, all cases                                          |
| `packages/core/test/probes.test.ts`                             | Retained, all cases                                          |
| `packages/core/test/publication-differential.test.ts`           | Retained, all cases                                          |
| `packages/core/test/publication-graph.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/realm-identity.test.ts`                     | Retained, all cases                                          |
| `packages/core/test/reference-resolution.test.ts`               | Retained, all cases                                          |
| `packages/core/test/registration-lifetime.test.ts`              | Retained, all cases                                          |
| `packages/core/test/regressions.test.ts`                        | Retained, all cases                                          |
| `packages/core/test/release-cancellation.test.ts`               | Retained, all cases                                          |
| `packages/core/test/replacement-contract.test.ts`               | Retained, all cases                                          |
| `packages/core/test/replacement-identity.test.ts`               | Retained, all cases                                          |
| `packages/core/test/replacement-races.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/replacement-rollback.test.ts`               | Retained, all cases                                          |
| `packages/core/test/retry-generation.test.ts`                   | Retained, all cases                                          |
| `packages/core/test/retry-lifecycle.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/runtime.test.ts`                            | Retained, all cases                                          |
| `packages/core/test/scope-close-attribution-effect.test.ts`     | Retained, all cases                                          |
| `packages/core/test/scope-close-attribution-release.test.ts`    | Retained, all cases                                          |
| `packages/core/test/service-task-lifecycle.test.ts`             | Retained, all cases                                          |
| `packages/core/test/slot-isolation.test.ts`                     | Retained, all cases                                          |
| `packages/core/test/span-attributes.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/supervisor-boundary.test.ts`                | Retained, all cases                                          |
| `packages/core/test/supervisor-failure-ownership.test.ts`       | Retained, all cases                                          |
| `packages/core/test/supervisor-interleavings.test.ts`           | Retained, all cases                                          |
| `packages/core/test/teardown-interleavings.test.ts`             | Retained, all cases                                          |
| `packages/core/test/terminal-settlement.test.ts`                | Retained, all cases                                          |
| `packages/core/test/transition-budgets.test.ts`                 | Retained, all cases                                          |
| `packages/core/test/transition.test.ts`                         | Retained, all cases                                          |
| `packages/core/test/trust.test.ts`                              | Retained, all cases                                          |
| `packages/core/test/update-cause-handoff.test.ts`               | Retained, all cases                                          |
| `packages/core/test/update-contract.test.ts`                    | Retained, all cases                                          |
| `packages/core/test/waterfall-context.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/waterfall-sharing.test.ts`                  | Retained, all cases                                          |
| `packages/core/test/weak-aliases.test.ts`                       | Retained, all cases                                          |
| `packages/create/templates/plugin/test/index.test.ts`           | Retained, all cases                                          |
| `packages/create/test/create-boundaries.test.ts`                | Retained, all cases                                          |
| `packages/create/test/create-causes.test.ts`                    | Retained, all cases                                          |
| `packages/create/test/create-errors.test.ts`                    | Retained, all cases                                          |
| `packages/create/test/create.test.ts`                           | Retained, all cases                                          |
| `packages/create/test/e2e.test.ts`                              | Retained, all cases                                          |
| `packages/create/test/install-cleanup.test.ts`                  | Retained, all cases                                          |
| `packages/create/test/package-manager-declaration.test.ts`      | Retained, all cases                                          |
| `packages/create/test/plugin-name.test.ts`                      | Retained, all cases                                          |
| `packages/create/test/resolve.test.ts`                          | Retained, all cases                                          |
| `packages/create/test/schema.test.ts`                           | Retained, all cases                                          |
| `packages/create/test/staging-lifecycle.test.ts`                | Retained, all cases                                          |
| `packages/create/test/template-app.test.ts`                     | Retained, all cases                                          |
| `packages/docs/check-links.test.mjs`                            | Retained, all cases                                          |
| `packages/docs/hover-types.test.mjs`                            | Retained, all cases                                          |
| `packages/docs/probes.test.mjs`                                 | Retained, all cases                                          |
| `packages/docs/publish.test.mjs`                                | Retained, all cases                                          |
| `packages/docs/reference.test.mjs`                              | Retained, all cases                                          |
| `packages/docs/snippets.test.mjs`                               | Retained, all cases                                          |
| `packages/hmr/test/changes.test.ts`                             | Retained, all cases                                          |
| `packages/hmr/test/integration.test.ts`                         | Retained, all cases                                          |
| `packages/hmr/test/replacement-imports.test.ts`                 | Retained, all cases                                          |
| `packages/hmr/test/session-lifecycle.test.ts`                   | Retained, all cases                                          |
| `packages/hmr/test/source-observation.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/atomic-write.test.ts`                     | Retained, all cases                                          |
| `packages/loader/test/candidate-scope.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/config-directory.test.ts`                 | Retained, all cases                                          |
| `packages/loader/test/config-graphs.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/config-schema.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/edit-admission.test.ts`                   | Retained, all cases                                          |
| `packages/loader/test/entry-boundaries.test.ts`                 | Retained, all cases                                          |
| `packages/loader/test/entry-id.test.ts`                         | Retained, all cases                                          |
| `packages/loader/test/entry-lists.test.ts`                      | Retained, all cases                                          |
| `packages/loader/test/env-refresh.test.ts`                      | Retained, all cases                                          |
| `packages/loader/test/extension-boundaries.test.ts`             | Retained, all cases                                          |
| `packages/loader/test/group-cleanup.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/group-entry-ids.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/group-env.test.ts`                        | Retained, all cases                                          |
| `packages/loader/test/group-identity.test.ts`                   | Retained, all cases                                          |
| `packages/loader/test/group-lifecycle.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/group-validation-boundaries.test.ts`      | Retained, all cases                                          |
| `packages/loader/test/import-cancellation.test.ts`              | Retained, all cases                                          |
| `packages/loader/test/import-module.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/include-alias.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/include-concurrency.test.ts`              | Retained, all cases                                          |
| `packages/loader/test/include-consistency.test.ts`              | Retained, all cases                                          |
| `packages/loader/test/include-entry-lists.test.ts`              | Retained, all cases                                          |
| `packages/loader/test/include-id-aliases.test.ts`               | Retained, all cases                                          |
| `packages/loader/test/include-initial.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/include-interruption.test.ts`             | Retained, all cases                                          |
| `packages/loader/test/include-ownership.test.ts`                | Retained, all cases                                          |
| `packages/loader/test/include-structure.test.ts`                | Retained, all cases                                          |
| `packages/loader/test/include-symlink.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/include-watch.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/include.test.ts`                          | Retained, all cases                                          |
| `packages/loader/test/incremental-reconcile.test.ts`            | Retained, all cases                                          |
| `packages/loader/test/intercept-env.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/intercept.test.ts`                        | Retained, all cases                                          |
| `packages/loader/test/loader.test.ts`                           | Retained, all cases                                          |
| `packages/loader/test/managed.test.ts`                          | Retained, all cases                                          |
| `packages/loader/test/observation-cleanup.test.ts`              | Retained, all cases                                          |
| `packages/loader/test/reconciliation.test.ts`                   | Retained, all cases                                          |
| `packages/loader/test/recovery-causes.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/refresh-serialization.test.ts`            | Retained, all cases                                          |
| `packages/loader/test/regressions.test.ts`                      | Retained, all cases                                          |
| `packages/loader/test/resolution-lifecycle.test.ts`             | Retained, all cases                                          |
| `packages/loader/test/resolution-plan.test.ts`                  | Retained, all cases                                          |
| `packages/loader/test/resolver-lifetime.test.ts`                | Retained, all cases                                          |
| `packages/loader/test/resolver-specifiers.test.ts`              | Retained, all cases                                          |
| `packages/loader/test/retry-activation.test.ts`                 | Retained, all cases                                          |
| `packages/loader/test/shared-graphs.test.ts`                    | Retained, all cases                                          |
| `packages/loader/test/snapshot-ownership.test.ts`               | Retained, all cases                                          |
| `packages/loader/test/store-protocol.test.ts`                   | Retained, all cases                                          |
| `packages/loader/test/tree-validation.test.ts`                  | Retained, all cases                                          |
| `packages/package-manager/test/committed-cleanup.test.ts`       | Retained, all cases                                          |
| `packages/package-manager/test/compound-causes.test.ts`         | Retained, all cases                                          |
| `packages/package-manager/test/declaration-schema.test.ts`      | Retained, all cases                                          |
| `packages/package-manager/test/detection-boundaries.test.ts`    | Retained, all cases                                          |
| `packages/package-manager/test/file-lifecycle.test.ts`          | Retained, all cases                                          |
| `packages/package-manager/test/file-types.test.ts`              | Retained, all cases                                          |
| `packages/package-manager/test/install-scripts.test.ts`         | Retained, all cases                                          |
| `packages/package-manager/test/manifest-preservation.test.ts`   | Retained, all cases                                          |
| `packages/package-manager/test/manifest-structure.test.ts`      | Retained, all cases                                          |
| `packages/package-manager/test/package-manager.test.ts`         | Retained, all cases                                          |
| `packages/package-manager/test/process-acquisition.test.ts`     | Retained, all cases                                          |
| `packages/package-manager/test/process-group-boundary.test.ts`  | Retained, all cases                                          |
| `packages/package-manager/test/process-group.test.ts`           | Retained, all cases                                          |
| `packages/package-manager/test/process-lifecycle.test.ts`       | Retained, all cases                                          |
| `packages/package-manager/test/published.test.ts`               | Retained, all cases                                          |
| `packages/package-manager/test/recovery-boundaries.test.ts`     | Retained, all cases                                          |
| `packages/package-manager/test/recovery-causes.test.ts`         | Retained, all cases                                          |
| `packages/package-manager/test/recovery-quarantine.test.ts`     | Retained, all cases                                          |
| `packages/package-manager/test/recovery-snapshot.test.ts`       | Retained, all cases                                          |
| `packages/package-manager/test/rollback-quarantine.test.ts`     | Retained, all cases                                          |
| `packages/package-manager/test/snapshot-metadata.test.ts`       | Retained, all cases                                          |
| `packages/package-manager/test/state-reads.test.ts`             | Retained, all cases                                          |
| `packages/package-manager/test/termination-evidence.test.ts`    | Retained, all cases                                          |
| `packages/package-manager/test/user-agent.test.ts`              | Retained, all cases                                          |
| `packages/package-manager/test/yarn-stream.test.ts`             | Retained, all cases                                          |
| `packages/plugin-http-api/test/authorization.test.ts`           | Retained, all cases                                          |
| `packages/plugin-http-api/test/conflict.test.ts`                | Retained, all cases                                          |
| `packages/plugin-http-api/test/context.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-http-api/test/documentation.test.ts`           | Retained, all cases                                          |
| `packages/plugin-http-api/test/extensions.test.ts`              | Retained, all cases                                          |
| `packages/plugin-http-api/test/middleware.test.ts`              | Retained, all cases                                          |
| `packages/plugin-http-api/test/openapi.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-http-api/test/recovery.test.ts`                | Retained, all cases                                          |
| `packages/plugin-http-api/test/serve.test.ts`                   | Retained, all cases                                          |
| `packages/plugin-http/test/config.test.ts`                      | Retained, all cases                                          |
| `packages/plugin-http/test/conflict.test.ts`                    | Retained, all cases                                          |
| `packages/plugin-http/test/context.test.ts`                     | Retained, all cases                                          |
| `packages/plugin-http/test/extensions.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-http/test/lifetime.test.ts`                    | Retained, all cases                                          |
| `packages/plugin-http/test/mcp.test.ts`                         | Retained, all cases                                          |
| `packages/plugin-http/test/mount.test.ts`                       | Retained, all cases                                          |
| `packages/plugin-http/test/oauth.test.ts`                       | Retained, all cases                                          |
| `packages/plugin-http/test/schema.test.ts`                      | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/catalog.test.ts`               | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/client-api.test.ts`            | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/contract-projection.test.ts`   | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/host.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/http.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/isolation.test.ts`             | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/kinds.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/lifecycle.test.ts`             | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/modern-api.test.ts`            | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/policy.test.ts`                | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/protocol.test.ts`              | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/regressions.test.ts`           | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/review-regressions.test.ts`    | Retained, all cases                                          |
| `packages/plugin-mcp-server/test/unix.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-otlp/test/extensions.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-otlp/test/otlp.test.ts`                        | Retained, all cases                                          |
| `packages/plugin-otlp/test/regressions.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-otlp/test/schema.test.ts`                      | Retained, all cases                                          |
| `packages/plugin-otlp/test/serialization.test.ts`               | Retained, all cases                                          |
| `packages/plugin-otlp/test/tuning.test.ts`                      | Retained, all cases                                          |
| `packages/plugin-release/test/contract.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-release/test/control.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-release/test/execution.test.ts`                | Retained, all cases                                          |
| `packages/plugin-release/test/resolution.test.ts`               | Retained, all cases                                          |
| `packages/plugin-release/test/storage.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-remote/test/artifact.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-remote/test/auth.test.ts`                      | Retained, all cases                                          |
| `packages/plugin-remote/test/bin.test.ts`                       | Retained, all cases                                          |
| `packages/plugin-remote/test/call-results.test.ts`              | Retained, all cases                                          |
| `packages/plugin-remote/test/candidate.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-remote/test/capabilities.test.ts`              | Retained, all cases                                          |
| `packages/plugin-remote/test/change-recovery-policy.test.ts`    | Retained, all cases                                          |
| `packages/plugin-remote/test/child-failures.test.ts`            | Retained, all cases                                          |
| `packages/plugin-remote/test/config-schema.test.ts`             | Retained, all cases                                          |
| `packages/plugin-remote/test/conformance-direct.test.ts`        | Retained, all cases                                          |
| `packages/plugin-remote/test/conformance.test.ts`               | Retained, all cases                                          |
| `packages/plugin-remote/test/connection.test.ts`                | Retained, all cases                                          |
| `packages/plugin-remote/test/contract.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-remote/test/credential-broker.test.ts`         | Retained, all cases                                          |
| `packages/plugin-remote/test/credential-scope.test.ts`          | Retained, all cases                                          |
| `packages/plugin-remote/test/encoded-channel.prototype.test.ts` | Retained, all cases                                          |
| `packages/plugin-remote/test/entries.test.ts`                   | Retained, all cases                                          |
| `packages/plugin-remote/test/entry-watch.test.ts`               | Retained, all cases                                          |
| `packages/plugin-remote/test/failure-group.test.ts`             | Retained, all cases                                          |
| `packages/plugin-remote/test/hardening.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-remote/test/lifecycle.test.ts`                 | Retained, all cases                                          |
| `packages/plugin-remote/test/managed-config.test.ts`            | Retained, all cases                                          |
| `packages/plugin-remote/test/network.test.ts`                   | Retained, all cases                                          |
| `packages/plugin-remote/test/plugins.test.ts`                   | Retained, all cases                                          |
| `packages/plugin-remote/test/policy-revisions.test.ts`          | Retained, all cases                                          |
| `packages/plugin-remote/test/policy.test.ts`                    | Retained, all cases                                          |
| `packages/plugin-remote/test/port.test.ts`                      | Retained, all cases                                          |
| `packages/plugin-remote/test/public-api.test.ts`                | Retained, all cases                                          |
| `packages/plugin-remote/test/publication.test.ts`               | Retained, all cases                                          |
| `packages/plugin-remote/test/release-cancellation.test.ts`      | Retained, all cases                                          |
| `packages/plugin-remote/test/request-id-reuse.test.ts`          | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-assembly.test.ts`           | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-framing.test.ts`            | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-notice.test.ts`             | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-packages.test.ts`           | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-processes.test.ts`          | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-store.test.ts`              | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-streams.test.ts`            | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-supervisor.test.ts`         | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-websocket.test.ts`          | Retained, all cases                                          |
| `packages/plugin-remote/test/runner-wire.test.ts`               | Retained, all cases                                          |
| `packages/plugin-remote/test/sandbox-cancellation.test.ts`      | Retained, all cases                                          |
| `packages/plugin-remote/test/services.test.ts`                  | Retained, all cases                                          |
| `packages/plugin-remote/test/socket-channel.test.ts`            | Retained, all cases                                          |
| `packages/plugin-remote/test/stdio-release.test.ts`             | Retained, all cases                                          |
| `packages/plugin-remote/test/telemetry-batching.test.ts`        | Retained, all cases                                          |
| `packages/plugin-remote/test/transition-driver.test.ts`         | Retained, all cases                                          |
| `packages/plugin-remote/test/transition.test.ts`                | Retained, all cases                                          |
| `packages/plugin-remote/test/trust.test.ts`                     | Retained, all cases                                          |
| `packages/plugin-remote/test/unit.test.ts`                      | Retained, all cases                                          |
| `packages/plugin-remote/test/worker.test.ts`                    | Retained, all cases                                          |
| `samples/01-hello/test/hello.test.ts`                           | Retained, all cases                                          |
| `samples/02-services/test/services.test.ts`                     | Retained, all cases                                          |
| `samples/03-events/test/events.test.ts`                         | Retained, all cases                                          |
| `samples/04-failures/test/failures.test.ts`                     | Retained, all cases                                          |
| `samples/05-config-file/test/config-file.test.ts`               | Retained, all cases                                          |
| `samples/06-remote/test/remote.test.ts`                         | Retained, all cases                                          |
| `samples/chat-bot/test/chat-bot.test.ts`                        | Retained, all cases                                          |
| `samples/checkout-upgrade/test/checkout-upgrade.test.ts`        | Retained, all cases                                          |
| `samples/http-gateway/test/http-gateway.test.ts`                | Retained, all cases                                          |
| `samples/integration-gateway/test/gateway.test.mjs`             | Retained, all cases                                          |
| `samples/integration-gateway/test/mcp.test.mjs`                 | Retained, all cases                                          |
| `samples/integration-gateway/test/releases.test.mjs`            | Retained, all cases                                          |
| `samples/market-feed/test/market-feed.test.ts`                  | Retained, all cases                                          |
| `samples/mcp-tools/test/configuration.test.ts`                  | Retained, all cases                                          |
| `samples/mcp-tools/test/content.test.ts`                        | Retained, all cases                                          |
| `samples/mcp-tools/test/mcp-tools.test.ts`                      | Retained, all cases                                          |
| `samples/saas-tenants/test/saas-tenants.test.ts`                | Retained, all cases                                          |
| `scripts/isolated-home.test.mjs`                                | Retained, all cases                                          |
| `scripts/packages.test.mjs`                                     | Retained, all cases                                          |
| `scripts/packed-ecosystem.test.mjs`                             | Retained, all cases                                          |
| `scripts/packed-gateway.test.mjs`                               | Retained, all cases                                          |
| `scripts/public-api.test.mjs`                                   | Retained, all cases                                          |

## Mechanism removal

| Path                                                                                  | Step 1 disposition                                                    |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `core/test/change-model/model.ts`                                                     | Deleted. All exploration imports `core/src/internal/decisionCore.ts`. |
| `core/test/change-model/adapter.ts`                                                   | Deleted. No replacement driver adapter.                               |
| `core/test/change-driver.ts`                                                          | Retained only for the old engine tests until step 2.                  |
| Old Change engine, host preparation/execution, Remote host paths and release adapters | Not deleted in step 1; required by steps 2, 3 and 6.                  |
