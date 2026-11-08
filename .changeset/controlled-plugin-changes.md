---
"@graftland/cli": minor
"@graftland/graft": minor
"@graftland/create": minor
"@graftland/loader": minor
"@graftland/package-manager": minor
"@graftland/plugin-http": minor
"@graftland/plugin-http-api": minor
"@graftland/plugin-mcp-server": minor
"@graftland/plugin-otlp": minor
"@graftland/plugin-release": minor
"@graftland/plugin-remote": minor
---

**Breaking:** Replace the previous transition, replacement and HMR APIs with
Changes addressed by stable instance identities. Use the Change planning and
submission APIs for running applications, and `graft start --watch` for saved
code and configuration edits. Configuration changes start a new generation;
there is no in-place update or global plugin alias.

**Breaking:** `graft start` now hosts the kernel and runs plugins in deployment
groups on Workers, child processes or runners. Local service dependencies keep
members in the same group; versioned contracts connect groups without forcing
compatible consumers to restart. Embedded `Graft.plugin` retains composition and
cooperative restarts, without Change outcomes or termination guarantees.

- Plan and observe each Change by id, including the affected members, execution
  evidence, failure causes and actual outcome. Independent Changes can proceed
  concurrently. `Restart` drains and replaces affected execution; opt-in
  `Overlap` switches compatible contract routes after readiness checks and
  probes. Runners support `Restart` only, and the Change path supports unary
  calls.
- Keep an unchanged gateway running while replacing a downstream integration.
  Capture code in immutable, content-addressed artifacts and use the same Change
  checks for development edits. Recovery reports whether service was restored;
  it does not promise to undo external effects or preserve memory.
- Supervise plugin failures with bounded restart intensity and observable
  escalation. Apply current trust policy during admission and recovery so a
  rollback cannot restore revoked permissions. Confine untrusted Process units
  with the Linux sandbox; other platforms cannot provide this confinement.
- Record Change intents and conclusions in an append-only durable journal,
  acknowledging records only after synchronization to disk. Preserve per-member
  facts and failure diagnostics so operators can investigate an unsuccessful
  change.
- Deliver bounded notifications through subscriber pulls with explicit delivery
  results. Do not automatically retry unknown delivery outcomes. Project
  annotated contracts to MCP tools and require renewed approval when exposed
  descriptions or grants change.
