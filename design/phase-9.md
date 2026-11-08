# Phase 9: value acceptance

Status: complete, 2026-11-08, pending the one independent GPT review of all
phases. Sources: plan Phase 9; `value.md` §2.1; `architecture.md` §11.

## First-release demo

`samples/integration-gateway` runs a separate kernel process, keeps one gateway
upstream session, upgrades the injected integration from version 1 to 2, then
attempts a deliberately broken version 3 whose `health` probe fails
(`requirements.probes: ["health"]`). `scripts/gateway-sample.test.mjs` runs all
three placements.

| Placement, strategy | Upgrade 1 → 2 | Broken upgrade 2 → 3 | Serving afterwards | Gateway sessions |
| ------------------- | ------------- | -------------------- | ------------------ | ---------------- |
| Worker, Overlap     | `Accepted`    | `Aborted`            | version 2          | 1                |
| Process, Restart    | `Accepted`    | `Recovered`          | version 2          | 1                |
| Runner, Restart     | `Accepted`    | `Recovered`          | version 2          | 1                |

Both upgrades end within their budget; the broken one keeps the probe's cause in
its outcome. Overlap aborts before the switch; Restart has already stopped
version 2, so it recovers it.

## Found and fixed during the demo

| Finding                                                                                                       | Fix                                                                               |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The Change request fields (`strategy`, `budget`, `requirements.probes`, `trial`) were undocumented            | `transitions.md` § Request fields (three languages)                               |
| `probes.md` described the deleted host coordinator (`policy.probes`, host Remote forks)                       | Rewritten: a Change runs `requirements.probes` (three languages)                  |
| A plugin's static `deployment.probes` is reported in its description but does not select probes               | Recorded as an open question for the review; probes are selected per Change       |
| `graft start` silently ignored `isolate`, `inject` and `intercept` set on a group (only entries were checked) | `Deployment.instances` rejects them on groups too; `deployment-instances.test.ts` |
| `embedding.md` said `graft start` rejects `--watch`                                                           | Corrected in three languages                                                      |
| The agent skills taught deleted APIs (`Graft.replace`, `@graftland/hmr`, `loader.retry`)                      | `skills/` rewritten against current source and docs                               |

## Status documents

- `value.md` §2.1: promises listed by evidence layer (code-verified, external,
  upstream, conditional).
- `architecture.md` §11.1: what exists and what still cannot be claimed.
- README: checked; it claims only implemented capabilities.

## Not done (value acceptance)

| Item                                           | Needs                    |
| ---------------------------------------------- | ------------------------ |
| Real gateway with a design partner             | External partner         |
| Two independent authors adopting the contracts | External authors         |
| Linux attack matrix on this branch             | Push, with owner consent |
