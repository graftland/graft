# Phase 8: trust and naming

Status: complete, 2026-11-08. Written by Claude; GPT reviews once after all
phases. Sources: plan Phase 8; `architecture.md` §2.1–2.4 (naming rules,
conflicts, recurrence checks), §5 (recovery re-checks current policy), slice 5
row of §11.2.

## Revocation

| Rule                                                     | Implementation                                                                                          | Evidence                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Revocation blocks admission first                        | Call admission only selects a provider whose current target the policy allows                           | `call-core.test.ts`: "admits no new call to a provider whose target was revoked …"                   |
| A concurrent Change does not keep a revoked premise      | A policy change fails every Change that observed the instance's authorization                           | `preparation-core.test.ts`, `preparation-exploration.test.ts` (existing)                             |
| Recovery re-checks current policy                        | Recovery resolves again and is denied when the old target was revoked                                   | `decision-core.test.ts`: "does not reuse revoked recovery authorization …"; `gateway-faults.test.ts` |
| The supervisor does not bring a revoked target back      | Restarting members and redeploying a crashed unit skip revoked targets; a skipped restart is no attempt | `supervision.test.ts`: two revocation tests (new)                                                    |
| Admitted calls of a revoked provider (in-process policy) | Fenced and their owners awaited, then terminated                                                        | `plugin-remote/test/policy.test.ts` (existing)                                                       |

Changed: `decisionCore.ts` `superviseMembers` / `superviseUnit` count only
authorized members as attempts, and `superviseUnit` redeploys only authorized
targets. Before, a restart of a revoked target was refused later at grant but
still used up the restart intensity.

## Renames (§2.3)

| Before                                                     | After                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| core `Release` module, `ReleaseInterrupted`                | `Finalization`, `FinalizationInterrupted`                       |
| Maintainer docs page "Releases" (`releases.md`)            | "Publishing" (`publishing.md`)                                  |
| `Manifest.Entry`, `Manifest.Host`                          | `Manifest.EntryMetadata`, `Manifest.HostProfile`                |
| `Artifact.Identity.entry`, `Artifact.capture({ entry })`   | `module`                                                        |
| `Trust.check(entry, candidate)`, `Unapproved.entry`        | `Trust.check(instance, attempt)`, `Unapproved.instance`         |
| `ModuleResolver.candidates` and "module candidate" in docs | `ModuleResolver.spellings`, "specifier spelling"                |
| `Plugin.Contract` (variance key)                           | `Plugin.Variance`                                               |
| `Projection.Change` (MCP view revision)                    | `Projection.Revision`                                           |
| HMR generations, remote `Instance` class, `RolledBack`     | Already deleted in Phase 4 / earlier                            |
| Runner generation                                          | Already `incarnation`; `generation` means the member generation |

Error classes renamed to their tags: `AdmissionRegistrationError`,
`ExtensionConflict`, `CapabilityDenied`, `UnitMessageLimit`,
`RunnerEndOfStream`.

## Recurrence checks (§2.4)

| Check                                                              | Where                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Error class name equals its `_tag`                                 | `scripts/check-names.mjs`, run by `scripts/check-names.test.mjs` (workspace project, CI test job) |
| Core words are bare export names only for owners or listed reasons | Same script; the allowed list gives each reason and fails when an entry goes stale                |
| Every core word is defined in the docs in three languages          | `packages/docs/glossary.test.mjs` against the "Core words" table of `concepts.md`                 |

## Linux attack matrix

Correction after the final review: this section first said the suite was
unchanged. It was not: Phase 2 deleted the host sandbox and its attack tests, so
`GRAFT_REQUIRE_SANDBOX` had no consumer. Confinement now belongs to unit targets
(`confinement: "Sandbox"` on Process units) and
`packages/plugin-remote/test/sandbox.test.ts` restores the attack test; see
`review-fixes.md` (H1). It passed on Linux in a local NixOS VM; CI runs it when
the branch is pushed.

## Not done

| Item                                                                                           | Why                                                                                     |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Status that says why a revoked instance is down                                                | The member shows unhealthy with its desired target; a reason field is a separate design |
| A revoked member in a shared unit blocks restarting its authorized co-members in one operation | Grant checks the whole operation; splitting it changes member-operation atomicity       |
