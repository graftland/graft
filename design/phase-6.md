# Phase 6: development experience acceptance

Status: complete, 2026-11-08. Written by Claude; GPT reviews once after all
phases. Sources: plan Phase 6; `architecture.md` §8.3 (latency baseline is
restarting the whole process).

## Long editing session

`packages/cli/test/dev-loop.test.ts` runs `graft start --watch` on one entry,
saves its module repeatedly and samples the host process after a warm-up of 5
edits and at the end. Thresholds between the two samples: RSS growth at most 96
MiB, no new TCP listeners, no new captured artifact directories.
`GRAFT_DEV_LOOP_EDITS` changes the edit count; results go to
`packages/cli/.cache/dev-loop.json`.

Measured on the development machine (macOS, Worker placement):

| Edits | Full restart to serving | Save to serving (median / p90 / max) | RSS after warm-up → end | Listeners | Artifacts |
| ----- | ----------------------- | ------------------------------------ | ----------------------- | --------- | --------- |
| 20    | 1 623 ms                | 819 / 879 / 968 ms                   | 456 → 482 MiB           | 1 → 1     | 2 → 2     |
| 80    | 1 729 ms                | 856 / 965 / 1 393 ms                 | 460 → 475 MiB           | 1 → 1     | 2 → 2     |

A reload takes about half the time of restarting the whole process, and only the
edited entry restarts. Memory levels off (+15 MiB over 75 edits); listeners and
artifacts stay constant because the Loader removes artifacts no running entry
uses after each accepted revision.

## Module formats

| Module       | Worker                    | Process   | Evidence                                   |
| ------------ | ------------------------- | --------- | ------------------------------------------ |
| ES module    | Supported                 | Supported | Every native test                          |
| CommonJS     | Supported                 | Supported | `module-formats.test.ts` (both placements) |
| Native addon | Only context-aware addons | Supported | Not tested; documented as untested         |

## Changed

- The Loader prunes captured artifacts that no applied target uses after each
  accepted revision (`Deployment.ts`, `prune`).
