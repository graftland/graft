# Phase 4 deletion manifest

Baseline `5e3529e`. Step 3 deletes the second change path. Kernel deployments
change only through Changes (`transitions`), development reload is
`graft start --watch`, and unowned failures belong to the supervisor.
`Plugin.Update` is **retained** for the embedded mode only (see `phase-4.md`,
step 3 decision).

## Deleted files

| File                                                     | Reason                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/core/src/internal/aliases.ts`                  | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/core/src/internal/replacement.ts`              | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/core/src/internal/unitGuard.ts`                | `ManagedFork`, `withUnmanaged` and `assertUnmanaged` are deleted                                      |
| `packages/core/test/definition-identity.test.ts`         | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/core/test/replacement-contract.test.ts`        | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/core/test/replacement-identity.test.ts`        | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/core/test/replacement-races.test.ts`           | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/core/test/replacement-rollback.test.ts`        | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/core/test/weak-aliases.test.ts`                | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/docs/content/docs/hmr-api.md`                  | Replaced by the CLI "Watch mode" section                                                              |
| `packages/docs/content/docs/hot-reload.md`               | Replaced by the CLI "Watch mode" section                                                              |
| `packages/docs/content/docs/replace.md`                  | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/docs/content/docs/zh-cn/hmr-api.md`            | Replaced by the CLI "Watch mode" section                                                              |
| `packages/docs/content/docs/zh-cn/hot-reload.md`         | Replaced by the CLI "Watch mode" section                                                              |
| `packages/docs/content/docs/zh-cn/replace.md`            | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/docs/content/docs/zh-tw/hmr-api.md`            | Replaced by the CLI "Watch mode" section                                                              |
| `packages/docs/content/docs/zh-tw/hot-reload.md`         | Replaced by the CLI "Watch mode" section                                                              |
| `packages/docs/content/docs/zh-tw/replace.md`            | `Graft.replace`, `Graft.resolve` and aliases are deleted                                              |
| `packages/hmr/README.md`                                 | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/README.zh-CN.md`                           | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/README.zh-TW.md`                           | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/package.json`                              | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/src/index.ts`                              | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/src/internal/changes.ts`                   | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/src/internal/digest.ts`                    | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/src/internal/modules.ts`                   | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/src/internal/sourceObservation.ts`         | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/test/changes.test.ts`                      | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/test/integration.test.ts`                  | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/test/replacement-imports.test.ts`          | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/test/runtime.ts`                           | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/test/session-lifecycle.test.ts`            | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/test/setup.mjs`                            | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/test/source-observation.test.ts`           | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/tsconfig.json`                             | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/tsconfig.test.json`                        | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/tsdown.config.ts`                          | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/hmr/vitest.config.ts`                          | The in-process HMR reload engine is replaced by `graft start --watch`                                 |
| `packages/loader/test/managed.test.ts`                   | `Loader.retry` and managed-tree guards are deleted                                                    |
| `packages/loader/test/refresh-serialization.test.ts`     | `Loader.retry` and managed-tree guards are deleted                                                    |
| `packages/loader/test/retry-activation.test.ts`          | `Loader.retry` and managed-tree guards are deleted                                                    |
| `samples/checkout-upgrade/README.md`                     | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/README.zh-CN.md`               | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/README.zh-TW.md`               | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/package.json`                  | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/src/Checkout.ts`               | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/src/Orders.ts`                 | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/src/main.ts`                   | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/src/plugins/checkout.ts`       | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/src/plugins/database.ts`       | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/src/plugins/pricing.ts`        | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/src/plugins/worker.ts`         | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/test/checkout-upgrade.test.ts` | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/tsconfig.json`                 | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `samples/checkout-upgrade/vitest.config.ts`              | The sample demonstrated `Graft.replace`; `samples/integration-gateway` shows upgrades through Changes |
| `scripts/fixtures/public-api/hmr.ts`                     | Depends only on deleted APIs                                                                          |

## Removed test cases in retained files

| File                                                 | Case                                                                                   | Reason                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/core/test/definition-identity.test.ts`     | does not replace a separate definition created with object spread                      | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/definition-identity.test.ts`     | replaces equal-looking sources independently in one batch                              | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/definition-identity.test.ts`     | does not remove another object                                                         | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/definition-identity.test.ts`     | redirects copied definitions through later versions and rollback by reference          | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/definition-identity.test.ts`     | rejects divergent targets for repeated references without changing aliases             | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/definition-identity.test.ts`     | ignores a definition                                                                   | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/cancellation-causes.test.ts`     | records an apply failure racing with replacement of that plugin                        | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/publication-graph.test.ts`       | keeps a rejected publisher failed until the other endpoint drops its dependency        | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/realm-identity.test.ts`          | rechecks a rejected publication with the same structural identity                      | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/background-tasks.test.ts`        | retains asynchronous errors in definitions even when launch errors are handled         | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/regressions.test.ts`             | retries a failed consumer when its dependency is replaced                              | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/regressions.test.ts`             | can load the original plugin after replacing a version back to it                      | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/event-claim.test.ts`             | withdraws the old once invocation during plugin ${change}                              | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/runtime.test.ts`                 | replaces running plugins and forwards later loads to the replacement                   | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/core/test/service-task-lifecycle.test.ts`  | dispose                                                                                | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/loader/test/env-refresh.test.ts`           | retry refreshes children a loading group already started                               | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/loader/test/include-entry-lists.test.ts`   | discovers an entry-list field introduced by a replacement                              | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/plugin-http-api/test/middleware.test.ts`   | injects bearer middleware, follows replacement, and becomes pending after withdrawal   | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/plugin-http-api/test/serve.test.ts`        | replaces and rolls back handlers                                                       | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/plugin-http-api/test/serve.test.ts`        | keeps mounts, composer and UI activations across listener port changes and replacement | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/plugin-http/test/mount.test.ts`            | replaces routes and restores them after rollback                                       | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/plugin-mcp-server/test/host.test.ts`       | serves the new handler after a replacement                                             | `Graft.replace` / `Graft.resolve` and aliases are deleted; deployments change through Changes |
| `packages/loader/test/env-refresh.test.ts`           | retry reads changed environment values in config and intercepts                        | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/extension-boundaries.test.ts`  | merge                                                                                  | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/group-cleanup.test.ts`         | retains restart cleanup failure on the actual plugin and retries its latest input      | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/group-lifecycle.test.ts`       | settles pending injections and applies their latest config when the service arrives    | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/include-entry-lists.test.ts`   | identifies a hand-added child before its first activation and writes only once         | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/incremental-reconcile.test.ts` | direct                                                                                 | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/intercept-env.test.ts`         | retries a failed intercept after its environment value becomes available               | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/managed.test.ts`               | rejects managed-tree edits before calling a store or changing its target               | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/refresh-serialization.test.ts` | direct                                                                                 | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/loader/test/retry-activation.test.ts`      | direct                                                                                 | `Loader.retry` is deleted; unowned failures belong to the supervisor                          |
| `packages/core/test/embedded-boundary.test.ts`       | captures unit membership before an embedded caller overrides its reference (I12)       | `ManagedFork` and the unmanaged guards are deleted                                            |

## Removed benchmark scenario

| Scenario  | Reason                                |
| --------- | ------------------------------------- |
| `replace` | No replacement API remains to measure |
