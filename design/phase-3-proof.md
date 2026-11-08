# Phase 3 evidence

Status: steps 1–2 are complete. Steps 3–6 are not complete. No architecture
contradiction or Effect public-API gap has been established. Groundwork
`c830f91` is retained. This inventory distinguishes native preparation from
cooperative embedded composition and does not claim group, recorder or CLI
kernel-only acceptance yet.

## Specification evidence inventory

| Evidence item (`phase-3.md:348–390`) | Current production evidence                                                                                                                                                          | Remaining work                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1. Core                              | Production reducer inspection admission, identity, snapshots, owned deadlines and exact exit settlement tests                                                                        | Group/recording exploration; new exploration states/transitions: 0 in step 1 |
| 2. Native                            | Real Worker/Process import, decode, configuration and resolver inspection; fresh environment/reference recovery; real runner Restart and clean disconnect                            | Multi-member lifecycle and collateral/shared exit evidence                   |
| 3. CLI boundary                      | Explicit watch rejection and one-shot configuration integration; candidate import guards run in disposable units                                                                     | Actual fixed start import graph and Loader control unit (step 5)             |
| 4. Gateway value                     | Retained public gateway tests only; no direct packed scripts executed                                                                                                                | New CLI/release/group value scenarios                                        |
| 5. Control plane                     | Existing public submit/query/cancel ownership remains                                                                                                                                | Recording grants, duties, barriers and crash windows (step 4)                |
| 6. Delivery                          | Case-level [deletion manifest](phase-3-deletion-manifest.md), exported descriptor/preparation/configuration types, three-language guides and built-module sample/generator migration | Full I/F inventory and parity audit (step 6)                                 |

## Step 1 acceptance

| Named test / suite                                                                                                | Cases         | Fact and residual assertion                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module-descriptor.test.ts`                                                                                       | 27            | Captured serializable descriptors; exact/conventional resolution, ambiguity, missing versus broken dependencies, encoded/suffixed paths, nested base, fresh installed bytes, native export conditions, declared external dependencies; no candidate executes in Loader. |
| `executes a custom resolver in a disposable unit and transfers only its validated descriptor (I1, F2)`            | 1 (within 27) | Resolver and independent candidate inspection finish with three Exited units.                                                                                                                                                                                           |
| `settles custom resolver complete/defect/blocked cleanup through owned native exit evidence (F2)`                 | 3 (within 27) | Cleanup marker is observed, defect Cause is retained, all inspections have Exited evidence and no unconfirmed unit. A blocked finalizer is terminated.                                                                                                                  |
| `terminates a custom resolver that blocks after an entry barrier while kernel queries remain responsive (I1, F2)` | 1 (within 27) | Filesystem entry barrier precedes the public query; deadline and actual native exit settle the inspection claim.                                                                                                                                                        |
| `preparation.test.ts`                                                                                             | 2             | Unknown instance may be inspected without serving authority; executable values and unregistered patches allocate no inspection unit.                                                                                                                                    |
| `inherits ordered intercept modules during disposable preparation and isolates a sibling's defaults (I1, F2)`     | 1             | Real Layer modules construct ordered parent/child settings; a sibling sees defaults; inspections exit without apply.                                                                                                                                                    |
| `rejects an invalid inherited patch without applying the plugin and retains settled inspection evidence (F2)`     | 1             | Invalid patch retains the complete failed preparation and Exited evidence; no apply marker.                                                                                                                                                                             |
| `rebuilds unit environments and resolves raw references again during real Restart recovery (F2)`                  | 1             | Policy changes red→green; fresh old-topology recovery writes `red/12` then `green/12`; exactly one current execution, Recovered healthy and not matching desired target.                                                                                                |
| `unit-configuration.test.ts`                                                                                      | 5             | Options/order affect validation identity; executable module/order affect authorization identity; invalid and Worker/Process blocked configuration preserve native evidence.                                                                                             |
| `rejects forged native code identity before resolving or spawning an inspection (I1, F2)`                         | 1             | Rejected with zero emitted commands and zero preparations.                                                                                                                                                                                                              |
| `snapshots native environment recipes and resolved module options before retaining them (I1, F2)`                 | 1             | Mutating caller-owned options/artifact records does not mutate retained request or resolution facts.                                                                                                                                                                    |
| `captures package bytes while excluding its nested artifact store and uncaptured dependencies (F2)`               | 1             | Filtered package closure is captured and independently verified; excluded symlinks and store do not enter the artifact.                                                                                                                                                 |
| `rejects watch before loading an invalid application revision (O6)`                                               | 1             | Real CLI returns unsupported diagnostic before reading invalid YAML.                                                                                                                                                                                                    |
| `fails CLI startup on invalid initial YAML without waiting for edits (O6)`                                        | 1             | Real CLI exits with YAML cause.                                                                                                                                                                                                                                         |
| `reads !env once from an env file after process environment values (F2, O6)`                                      | 1             | Process values, including empty strings, win over file values.                                                                                                                                                                                                          |

Retained embedded merge/registration defect tests use real module fixtures.
Their cooperative lifecycle does not prove kernel isolation. Existing Phase 2
I/F identifiers retain their original meaning; they are not silently counted as
new Phase 3 group invariants.

## Interpretations and deviations

| Reading                  | Source lines                                                       | Implementation                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native export conditions | `phase-3.md:128–133`; `architecture.md:87–101`                     | Built Worker/Process execution selects Node default import conditions. Worker bootstrap clears inherited development/source execArgv. A conditional-export fixture rejects selection of development source.                                                                                                     |
| Capture boundary         | `phase-3.md:129`; `architecture.md:519,548`                        | Capture the package-local closure, with explicit exclusions for dependency links/generated stores. Record declared uncaptured dependency versions/locations; mark inventory coverage Declared. No claim to pin undeclared dynamic imports. Local modules require a package manifest to define the capture root. |
| Built sources            | `phase-3.md:129`; `architecture.md:548`                            | Samples and generated applications build JavaScript before capture. No source-evaluation or watch adapter is retained.                                                                                                                                                                                          |
| Custom extensions        | `phase-3.md:130–138`                                               | Resolver default Effect and configuration default Layer are immutable unit-loaded modules using encoded Options. Dynamic Effect contexts are confined to a documented, single-line diagnostic boundary; no cast or global diagnostic suppression.                                                               |
| Memoization              | `phase-3.md:130–131`                                               | Each ordered configuration recipe uses a fresh Layer. A production native test caught accidental reuse of a parent's memoized settings.                                                                                                                                                                         |
| Embedded scope           | `phase-3.md:62,317–320,323,327,331–335`; `architecture.md:119–127` | Explicit embedded composition roots may import captured descriptors. They provide cooperative composition only. No Plugin-valued resolver/importer adapter remains. The actual hosted start path is removed in step 5.                                                                                          |
| CLI editing              | `phase-3.md:104` (O6), `323,327`                                   | Watch integration is removed and rejected explicitly. Automatic deployment edits/retry are deferred to Phase 4, not routed through an old start engine.                                                                                                                                                         |
| Code authorization       | `phase-3.md:129–133`; `architecture.md:431–451,548`                | Pure shared identity generation binds ordered executable configuration modules. The core verifies identity from deployment data before any resolver command; public callers cannot substitute code under an old identity.                                                                                       |
| Groundwork local Overlap | `phase-3.md:102,186–190`; `architecture.md:333–343`                | Contract-free execution remains Restart-only: A:333 requires a contract as well as an overlap declaration. Group validation checks every selected member, resource and placement; it never invents a contract.                                                                                                  |

## Groundwork check history

All shell commands ran through `devenv shell --`. Logs use the local prefix
`/tmp/graft-phase3-`; they are development records, not checked-in artifacts.

| Check or batch                            | Result and correction                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial shell entries before installation | Formatting hook could not find `@ianvs/prettier-plugin-sort-imports`. Requested file reads still ran. Frozen-lockfile installation subsequently succeeded.                                                                                                             |
| Baseline `pnpm build`                     | Passed, including documentation generation and 2,299 built pages.                                                                                                                                                                                                      |
| First runner fixture                      | Two failures: the absolute Unix socket pathname produced EACCES. Replaced it with a short worktree-relative socket path and explicitly created its containing directory; no temporary workspace or symlink was created.                                                |
| Runner red batch                          | One failed, one passed. Clean EOF logged Error rather than Debug.                                                                                                                                                                                                      |
| First runner classification batch         | One failed, one passed. The malformed-input test exposed that parsing in a fork did not reliably report its failure before clean EOF. Parsing now precedes command dispatch; owned command failures are reported too.                                                  |
| Contract-free native red batch            | Two failed, eleven passed. The required contract field prevented a contract-free target from being constructed and inspected.                                                                                                                                          |
| First contract-free typecheck             | Failed on stale built core declarations, dynamic context requirements and an unnecessarily untyped schema decoder. Rebuilt core declarations, supplied the native context explicitly and used `decodeEffect`.                                                          |
| Initial native green batch                | Fifteen tests passed across the native and runner files.                                                                                                                                                                                                               |
| First real runner shutdown assertion      | Failed because shutdown admission returned before its asynchronous native exit arrived. The test now waits for actual exit facts rather than asserting synchronous exit.                                                                                               |
| Three runner diagnostic batches           | Test guard timeouts. A test-only `Queue.takeAll` waited forever on the correctly empty log queue. Replaced it with the public nonblocking `Queue.clear`; temporary file tracing and the diagnostic timeout wrapper were removed. These timeouts are not exit evidence. |
| Diagnostic-wrapper typecheck              | Failed the timeout/catch diagnostic. Removed the temporary diagnostic wrapper; no rule was disabled.                                                                                                                                                                   |
| Descriptor assertion typecheck            | Failed the native `Object.hasOwn` diagnostic. Replaced the redundant assertion with an absent-contract assertion; structural round-trip equality already checks the descriptor.                                                                                        |
| Specification comparison tool             | One heredoc redirection syntax error; the corrected command confirmed formatting-only changes.                                                                                                                                                                         |
| Later targeted native/runner batch        | Twenty-one tests passed before the serialization case was added.                                                                                                                                                                                                       |
| Final typecheck                           | Passed.                                                                                                                                                                                                                                                                |
| Final build                               | Passed, including TypeDoc and the three-language site build.                                                                                                                                                                                                           |
| Full root test                            | 289 files passed, one failed; 2,129 tests passed, 45 skipped, one failed. The only failure is the explicitly allowed macOS benchmark case `resolves compressed sample files relative to nested result outputs` (`/proc` ENOENT).                                       |
| Independent docs test                     | Passed: 25 Node/TypeDoc tests and 19 Vitest files with 39 tests.                                                                                                                                                                                                       |
| Final `treefmt --no-cache` and diff check | Passed: 1,051 files processed, zero changes; `git diff --check` passed.                                                                                                                                                                                                |

No check was manually interrupted. Test-runner guard timeouts are listed above.
No direct packed script, outward action, push, rebase, stash, reset or `gh`
command was run. Packed runtime verification remains owner-run work.

## Step 1 failed checks

All logged failed verification attempts, including intended red tests, are
listed below. Log names use `/tmp/graft-phase3-step1-` as their prefix.
Migration failures were corrected in production code or real fixtures; no
diagnostics were globally disabled. A passing full check, rather than a targeted
rerun alone, is required before the step commit.

| Log suffix                            | Result                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact-red.log`                    | Test Files 1 failed (1); Tests 1 failed / 9 passed (10)                                                                                |
| `blocked-configuration.log`           | Test Files 1 failed (1); Tests 1 failed / 3 passed (4)                                                                                 |
| `cli-intercept-fixtures.log`          | Test Files 1 failed (1); Tests 7 failed (7)                                                                                            |
| `code-trust-red.log`                  | Test Files 1 failed (1); Tests 2 failed / 23 passed (25)                                                                               |
| `common-fixtures.log`                 | Test Files 1 failed / 2 passed (3); Tests 1 failed / 17 passed (18)                                                                    |
| `common-fixtures2.log`                | Test Files 1 failed / 2 passed (3); Tests 1 failed / 17 passed (18)                                                                    |
| `configuration-authority-red.log`     | Test Files 1 failed (1); Tests 1 failed / 4 passed (5)                                                                                 |
| `configuration-red.log`               | Test Files 1 failed (1); Tests 2 failed (2)                                                                                            |
| `configuration-red2.log`              | Test Files 1 failed (1); Tests 2 failed (2)                                                                                            |
| `configuration-red3.log`              | Test Files 1 failed (1); Tests 2 failed (2)                                                                                            |
| `core-red.log`                        | Test Files 1 failed (1); Tests 2 failed / 21 passed (23)                                                                               |
| `custom-resolver-red.log`             | Test Files 1 failed (1); Tests 3 failed / 15 passed (18)                                                                               |
| `descriptor-green.log`                | Test Files 1 failed (1); Tests 3 failed / 1 passed (4)                                                                                 |
| `descriptor-red.log`                  | Test Files 1 failed (1); Tests 4 failed (4)                                                                                            |
| `docs1.log`                           | ℹ pass 24; ℹ fail 1                                                                                                                    |
| `documentation-green.log`             | Test Files 1 failed (1); Tests 2 failed (2)                                                                                            |
| `embedded-echo.log`                   | Test Files 1 failed (1); Tests 1 failed / 1 passed (2)                                                                                 |
| `environment-descriptor-green.log`    | Test Files 1 failed (1); Tests 1 failed / 13 passed (14)                                                                               |
| `environment-descriptor-red.log`      | Test Files 1 failed (1); Tests 1 failed / 13 passed (14)                                                                               |
| `external-dependencies-red.log`       | Test Files 1 failed (1); Tests 1 failed / 18 passed (19)                                                                               |
| `foundation-typecheck.log`            | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `generated-fixtures.log`              | Test Files 5 failed / 1 passed (6); Tests 8 failed / 21 passed (29)                                                                    |
| `generator-localized-red.log`         | Test Files 1 failed (1); Tests 2 failed / 8 passed (10)                                                                                |
| `generator-red.log`                   | Test Files 1 failed (1); Tests 4 failed / 6 passed (10)                                                                                |
| `http-mcp-tests.log`                  | Build/global setup failed; subsequent rebuild and migration checks replace this attempt.                                               |
| `identity-fixtures.log`               | Test Files 3 failed (3); Tests 5 failed / 4 passed (9)                                                                                 |
| `loader-build.log`                    | Build/global setup failed; subsequent rebuild and migration checks replace this attempt.                                               |
| `loader-fixtures-all2.log`            | Test Files 7 failed / 37 passed (44); Tests 5 failed / 207 passed (212)                                                                |
| `loader-fixtures-all3.log`            | Test Files 2 failed / 42 passed (44); Tests 4 failed / 218 passed (222)                                                                |
| `loader-migration-test.log`           | Test Files 35 failed / 16 passed (51); Tests 130 failed / 138 passed (268)                                                             |
| `migration-typecheck.log`             | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `migration-typecheck2.log`            | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `migration-typecheck3.log`            | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `migration-typecheck4.log`            | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `native-conditions-red.log`           | Test Files 1 failed (1); Tests 1 failed / 14 passed (15)                                                                               |
| `native-configuration-regression.log` | Test Files 1 failed / 1 passed (2); Tests 2 failed / 18 passed (20)                                                                    |
| `otlp-all2.log`                       | Test Files 1 failed / 5 passed (6); Tests 8 failed / 29 passed (37)                                                                    |
| `otlp-extension3.log`                 | Test Files 1 failed (1); Tests 8 failed / 5 passed (13)                                                                                |
| `otlp-extension4.log`                 | Test Files 1 failed (1); Tests 7 failed / 6 passed (13)                                                                                |
| `otlp-extension5.log`                 | Test Files 1 failed (1); Tests 2 failed / 11 passed (13)                                                                               |
| `otlp-fixtures.log`                   | Test Files 3 failed (3); Tests 7 failed / 4 passed (11)                                                                                |
| `preparation-environment-red.log`     | Test Files 1 failed (1); Tests 1 failed / 2 passed (3)                                                                                 |
| `preparation-green.log`               | Test Files 1 failed / 1 passed (2); Tests 1 failed / 15 passed (16)                                                                    |
| `preparation-red.log`                 | Test Files 1 failed (1); Tests no tests                                                                                                |
| `remote-configuration-build.log`      | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `resolution-context-red.log`          | Test Files 1 failed (1); Tests 1 failed / 19 passed (20)                                                                               |
| `resolver-typecheck.log`              | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `test1.log`                           | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `test2.log`                           | Test Files 5 failed / 279 passed (284); Tests 16 failed / 2089 passed / 45 skipped (2150)                                              |
| `typecheck11.log`                     | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `typecheck14.log`                     | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |
| `typecheck9.log`                      | Type/declaration check failed; stale generated public declarations, missing context, removed APIs or style diagnostics were corrected. |

## Step 1 exit checks

| Check                                | Result                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`     | Passed; lockfile unchanged by installation.                                                                                                                                                                    |
| `pnpm typecheck`                     | Passed, no diagnostics (`typecheck16.log`, repeated after dead-helper removal as `typecheck17.log`).                                                                                                           |
| `pnpm build`                         | Passed, TypeDoc and 2,347 site pages (`build2.log`).                                                                                                                                                           |
| `pnpm test`                          | 2,099 passed, 45 skipped; 283 files passed, one failed. The only failure is the allowed benchmark `resolves compressed sample files relative to nested result outputs` (`/proc` ENOENT on macOS), `test3.log`. |
| `pnpm --filter @graftland/docs test` | Passed: 25 Node/TypeDoc checks and 36 Vitest tests across 17 files (`docs3.log`).                                                                                                                              |
| `treefmt --no-cache`                 | Passed with zero changed files (`format1.log`), repeated after recording the evidence.                                                                                                                         |
| `git diff --check`                   | Passed.                                                                                                                                                                                                        |

No verification was manually interrupted. Guard timeouts and failed migration
attempts appear in the check history. A failed full run before the final run had
16 failures (15 CLI/fixture migration failures plus the allowed benchmark); the
final full run contains only the benchmark failure. A full run also failed
global public-API setup until its removed `fromRecord` use was migrated.

No direct packed script or outward action was run. Packed runtime certification
remains owner-run work.

## Step 2 acceptance

Production planning is `internal/groupGraph.ts`, called by the production
reducer. Tests import these production functions; no independent planner or
counter model is used. The singleton member count and scalar status/conclusion
member field are deleted. All selection reasons and predecessors are retained as
immutable data. Unit-member grants cross native transport using the public
Schema JSON codec, preserving HashMap/HashSet/Option values.

| Evidence                                                                                                                              | Cases / exploration                            | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group-planning.test.ts`                                                                                                              | 16 cases                                       | Repeated split-to-merge closure; distinct realms and compatible external contract consumer; Scope descendants; placement/missing-provider/cycle/Overlap rejection before Stop; old/new membership and optional-absence reservations; distinct shared old claims and split capacity; initial and removed member facts; immutable caller inputs; patch-only commit/recovery preserving B; consulted realm ancestry; realm ancestry edits reclosing both graphs; collateral authorization. |
| `explores every conflicting split, optional-provider creation and shutdown order through the production reducer (I2, I4, I5, F1, F6)` | 6 schedules, 16 visited states, 15 transitions | Complete reservation excludes the conflicting operation in every causal order; shutdown never releases unconfirmed execution. Included in the 24 cases above.                                                                                                                                                                                                                                                                                                                           |
| `decision-access.test.ts`                                                                                                             | 2 cases                                        | Real Effect collection spies include all graph indexes, propagate labels through immutable writes, reject scans and compare equal access counts with 0 and 2,000 unrelated active Changes. A deliberate whole-index read is detected.                                                                                                                                                                                                                                                   |
| `group-description.test.ts`                                                                                                           | 1 case                                         | Identified parent/child, local edges, resource placement and optional values round-trip through the production JSON codec.                                                                                                                                                                                                                                                                                                                                                              |
| `never reuses an identified description for another instance with the same artifact and configuration (I2, I4, F3)`                   | 1 case                                         | Another instance receives its own disposable inspection; cached identified declarations cannot silently delete that instance or borrow serving authority.                                                                                                                                                                                                                                                                                                                               |

Step 1 commit: `3e0e324`. Step 2 full exit checks are recorded below.

### Step 2 interpretations

| Reading                      | Sources                                                 | Decision                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identified description cache | `phase-3.md:132–133`; `architecture.md:207–221`         | Cache identity includes instance, realm, co-location and explicit placement coordinates as well as the captured target. It cannot rebind declarations from another root instance.                          |
| Static module metadata       | `phase-3.md:99–104,132`; `architecture.md:327,340–343`  | A plugin module's static `deployment` data declares resource, placement and probe requirements; Describe validates it without apply. Existing Plugin local/contract declarations supply the service facts. |
| Default strategy             | `phase-3.md:102,176–180,199–205` (O3)                   | Normalize omitted strategy to Restart. Existing tests that require Overlap now request it explicitly; contract-free modules remain Restart-only under A:333.                                               |
| Unrelated applications       | `phase-3.md:150–155`; `architecture.md:107–115,431–451` | Gateway fault fixtures publishing the same textual service key use a distinct declared realm for unrelated B. Their provider slots and reservations are genuinely independent.                             |

### Step 2 check history

All logs below have prefix `/tmp/graft-phase3-step2-`. No check has been
manually interrupted.

- Planning red runs: `planning-red2.log` (8 failures), `capacity-red.log`,
  `proposal-snapshot-red1.log`, `patch-red1.log`, `realm-red1.log`,
  `authorization-red1.log`, and `cache-red1.log`. Each regression was run before
  its corresponding implementation.
- Initial planning red used an invalid event tag (`Submitted`); corrected to
  production `Submit` before interpreting the eight acceptance failures.
- Description codec attempts `description-green1` through `description-green3`
  failed because the test supplied runtime Options to an encoded JSON decoder.
  The test now validates runtime data with `Schema.toType` and round-trips
  through `Schema.toCodecJson`; no codec adapter remains.
- `typecheck1.log` through `typecheck10.log` failed during the field, codec and
  fixture migration. Errors included obsolete scalar descriptions, stale built
  public declarations, Effect 4 collection API usage, a temporary unused import,
  a temporary debug expression, a mistaken HashMap import from `node:net`, and a
  fixture identifier replacement. `typecheck11` through `typecheck14` pass.
- `core-typecheck6.log` did not run a compiler: the package has no typecheck
  script. The required root `pnpm typecheck` is the compiler check.
- `core-build2.log` failed on incorrect Effect String.startsWith argument form;
  `core-build3.log` and the later full build pass.
- `model1.log`, `model2.log`, `model3.log`, `core-tests1.log`,
  `core-tests2.log`, `core-tests3.log` failed during migration. Corrections
  include removing obsolete unsupported-group tests/self-touch counters,
  retaining concrete membership conflicts, making mock descriptions belong to
  the requested instance, preserving normalized request identity before adding
  core reservations, and handling group-owned idle exits. `core-tests4.log`
  passes all 887 core cases at that point.
- `root-tests1.log`: 2,105 passed, 45 skipped, 9 failed. Besides the allowed
  benchmark failure, failures were three sample scalar/cache migrations and five
  gateway fault cases needing explicit Overlap/distinct unrelated realms.
- `gateway2.log`: 12 passed, 4 failed. Three sample cases exposed cross-instance
  description-cache reuse; the remaining Runner Busy test accidentally requested
  unsupported Overlap and was corrected to Restart.
- `sample-debug1.log` and `sample-debug2.log` failed with reserved capacity
  unavailable. Their observations exposed a cached description for another
  instance, producing an empty desired plan. The cache regression test and fix
  above address the cause; temporary debug output is removed.
- `docs1.log` failed two Node assertions (the enclosing suite and the old
  `Change.Status.member` field assertion). API reference coverage now requires
  `members` and `plan`. `docs2.log` passes 25 Node cases and 36 Vitest cases.

Additional Step 2 counterexamples: `aba-red1.log` fails before deletion-only
settlement is implemented; `aba-green1.log` passes provider creation, deletion,
tombstone version 0→1→2, and stale absence rejection through production
commands. `footprint-red1.log` fails two cases before rejecting proposed
unreserved future declarations and recording the binding/participant footprint
of a compatible external consumer redirected by a realm edit;
`footprint-green1.log` passes. `realm-validation-red1.log` fails invalid cycle
and missing-parent cases even with optional requirements; their production
ancestry validation and consulted realm reservations pass in
`realm-validation-green1.log`. The graph test suite has 21 cases before the
old-eligibility cases below.

`root-tests2.log` passes 2,116 cases with 45 skipped and only the allowed
benchmark failure (286 files). `root-tests3.log` passes 2,117 cases with 45
skipped and the same allowed failure. `build3.log` failed because I ran it at
the same time as the root tests, whose setup rebuilds native outputs: CLI schema
generation observed a temporarily removed Remote `dist/Artifact.js`. The build
and root suite share outputs and must be run sequentially. This was a check
orchestration error, not an Effect API gap. `typecheck16.log` then failed
against stale built core declarations after adding previous dependency facts; a
completed build is required before rechecking downstream projects. No casts or
compatibility fields were added for those stale outputs.

`old-overlap-red1.log` fails both old member and resource eligibility cases;
`old-overlap-green1.log` passes them. Eligibility is checked for the old and new
moved declarations, including removed members, because resource reuse may be
unsafe even when only the new declaration permits overlap
(`phase-3.md:176–180,199–205`; `architecture.md:333–343`). An additional old
Runner-placement case brings the graph suite to 24 cases. This exposed an
obsolete model fixture in `root-tests4.log`: it attempted Overlap from a
Restart-only Runner into a Worker. The retained absolute-deadline/fresh-term
recovery test now uses an eligible old Process declaration and still proves
recovery returns to the old placement after retiring both attempts. Runner
Overlap remains rejected; no trust downgrade or strategy fallback is added.
`recovery-placement1.log` passes all 46 targeted cases. The planner has also
been split into named selection, validation and plan-assembly functions;
`graph-refactor1.log` preserves real-index locality and all graph assertions.

### Step 2 exit checks

| Check                                | Result                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`                         | Passed, including TypeDoc and 2,383 pages (`build6.log`).                                                                      |
| `pnpm typecheck`                     | Passed without diagnostics (`typecheck18.log`).                                                                                |
| `pnpm test`                          | 2,124 passed, 45 skipped; 285 files passed and the single allowed macOS benchmark failure (`root-tests5.log`), 130.10 seconds. |
| `pnpm --filter @graftland/docs test` | 25 Node cases and 36 Vitest cases passed (`docs6.log`).                                                                        |
| `treefmt --no-cache`                 | Passed with zero changed files (`format2.log`), repeated after this evidence update before commit.                             |

The final check batch ran the build, compiler, root tests, docs tests and
formatter sequentially. No check was manually interrupted. `root-tests4.log` had
2,122 passes, 45 skips and two failures: the allowed benchmark and the obsolete
Runner-to-Worker Overlap fixture described above. The corrected final run has
only the benchmark failure.

### Step 2 complete failed-check inventory

Every failed test/typecheck/build log available from this step is listed here;
red acceptance runs are intentional. Green-named files can contain failed
intermediate attempts and are retained in this inventory for that reason.

| Log (`/tmp/graft-phase3-step2-`) | Last test summary or failure class         |
| -------------------------------- | ------------------------------------------ |
| `aba-red1.log`                   | 1 failed / 16 passed (17)                  |
| `authorization-red1.log`         | 1 failed / 14 passed (15)                  |
| `build3.log`                     | TypeScript/build failure                   |
| `cache-red1.log`                 | 1 failed / 25 passed (26)                  |
| `capacity-green1.log`            | 1 failed / 9 passed (10)                   |
| `capacity-red.log`               | 2 failed / 8 passed (10)                   |
| `core-build2.log`                | TypeScript/build failure                   |
| `core-tests1.log`                | 5 failed / 880 passed (885)                |
| `core-tests2.log`                | 27 failed / 858 passed (885)               |
| `core-tests3.log`                | 3 failed / 882 passed (885)                |
| `description-green1.log`         | 1 failed (1)                               |
| `description-green2.log`         | 1 failed (1)                               |
| `description-green3.log`         | 1 failed (1)                               |
| `description-red.log`            | 1 failed (1)                               |
| `docs1.log`                      | TypeScript/build failure                   |
| `footprint-red1.log`             | 2 failed / 17 passed (19)                  |
| `gateway2.log`                   | 4 failed / 12 passed (16)                  |
| `model1.log`                     | 8 failed / 37 passed (45)                  |
| `model2.log`                     | 5 failed / 54 passed (59)                  |
| `model3.log`                     | 1 failed / 53 passed (54)                  |
| `old-overlap-red1.log`           | 2 failed / 21 passed (23)                  |
| `patch-red1.log`                 | 2 failed / 11 passed (13)                  |
| `planning-red.log`               | 5 failed (5)                               |
| `planning-red2.log`              | 8 failed (8)                               |
| `proposal-snapshot-red.log`      | 1 failed / 10 passed (11)                  |
| `realm-red1.log`                 | 1 failed / 13 passed (14)                  |
| `realm-validation-red1.log`      | 2 failed / 19 passed (21)                  |
| `root-tests1.log`                | 9 failed / 2105 passed / 45 skipped (2159) |
| `root-tests2.log`                | 1 failed / 2116 passed / 45 skipped (2162) |
| `root-tests3.log`                | 1 failed / 2117 passed / 45 skipped (2163) |
| `root-tests4.log`                | 2 failed / 2122 passed / 45 skipped (2169) |
| `root-tests5.log`                | 1 failed / 2124 passed / 45 skipped (2170) |
| `sample-debug1.log`              | Node assertion or sample failure           |
| `sample-debug2.log`              | Node assertion or sample failure           |
| `typecheck1.log`                 | TypeScript/build failure                   |
| `typecheck10.log`                | TypeScript/build failure                   |
| `typecheck13.log`                | TypeScript/build failure                   |
| `typecheck16.log`                | TypeScript/build failure                   |
| `typecheck2.log`                 | TypeScript/build failure                   |
| `typecheck3.log`                 | TypeScript/build failure                   |
| `typecheck4.log`                 | TypeScript/build failure                   |
| `typecheck5.log`                 | TypeScript/build failure                   |
| `typecheck6.log`                 | TypeScript/build failure                   |
| `typecheck7.log`                 | TypeScript/build failure                   |
| `typecheck8.log`                 | TypeScript/build failure                   |
| `typecheck9.log`                 | TypeScript/build failure                   |
