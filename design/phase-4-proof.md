# Phase 4 evidence

Status: steps 1–3 complete. Written by Claude; GPT reviews once after all
phases. Deletions are listed in
[phase-4-deletion-manifest.md](phase-4-deletion-manifest.md).

| Rule (`phase-4.md`)                                                         | Evidence                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Member failure restarts within the intensity, then escalates and only stops | `supervision.test.ts`: `restarts a failed member within the restart intensity, then escalates and only stops it (C8)`                                                                                                       |
| Attempts per period, kept across generations                                | `supervision.test.ts`: `counts only attempts inside the period and keeps them across generations (C8)`                                                                                                                      |
| Unit crash → one supervisor Change; exhausted → escalation                  | `supervision.test.ts`: `redeploys a crashed unit through one ordinary supervisor request…`; native `supervision-native.test.ts`: `redeploys a crashed native unit through a supervisor Change and records the attempt (C8)` |
| No attempt during shutdown                                                  | `supervision.test.ts`: `starts no supervisor attempt during kernel shutdown (C8)`                                                                                                                                           |
| Watch: changed entries only, removal, process keeps running                 | `start-integration.test.ts`: `turns saved modules and config edits into Changes for the affected entries while the process keeps running (C9)`                                                                              |
| The config file is not part of any artifact                                 | `start-integration.test.ts`: `keeps the config file out of artifacts, so editing one entry's config redeploys only that entry (C9)`                                                                                         |
| Quickstart walk-through                                                     | Reproduced on a template-shaped app: a greeting edit restarts `greeter` and `ticker` only; a code edit restarts every entry of the package; disabling `greeter` is rejected and logged while everything keeps running.      |
| Deleted APIs gone everywhere                                                | Workspace typecheck and docs build (TypeDoc validation) pass; no source, sample or guide mentions them.                                                                                                                     |

## Interpretations and gaps

| Item                     | Decision                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Plugin.Update`          | Retained for the embedded mode (see `phase-4.md`, step 3 decision). Kernel deployments never use it.                                             |
| Busy restarts            | Deferred restarts retry after every event (`retryPending`); no reducer test constructs a member restart blocked by another Change's reservation. |
| Backoff                  | Not implemented; attempts are immediate and bounded by intensity.                                                                                |
| Busy edits in watch mode | Resubmitted every 250 ms while the kernel answers `Busy`.                                                                                        |
| Artifact granularity     | A module's artifact is its whole package, so a code edit redeploys every entry of that package.                                                  |
