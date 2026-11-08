# Phase 3: deployment groups and Loader placement

Status: implementation specification, 2026-11-08. The owner decisions below are
explicit gates, not choices delegated to the implementer. Recommendations are
specified far enough to implement once accepted. This is a plan, not evidence
that Phase 3 works.

## Scope and sources

Promise: the main thread of `graft start` contains only the fixed kernel and its
bootstrap. Every plugin, including Loader control-plane code, the gateway and
release plugin, executes in a unit. Workers still share the host OS process;
“host imports no plugin” means the kernel execution context and its import
graph, not that Worker isolates cannot import plugins. This reading follows the
architecture's process diagram and Worker definition (A:72–101).

Source citations use `alias:line–line`, with repository line numbers at the
start of this change. The aliases link to the source files. P and U identify
numbered lines of the owner's task, reproduced below because it has no file.
Precedence is V/A, P, S/E, then current code; U supplies the project decisions.

| Alias | Source |
| --- | --- |
| V | [value.md](value.md), v2 |
| A | [architecture.md](architecture.md), v1.0 |
| S | [phase-2.md](phase-2.md) |
| E | [phase-2-proof.md](phase-2-proof.md) |
| D | [documentation style](../packages/docs/STYLE.md) |

| Task line | Controlling Phase 3 text |
| --- | --- |
| P1 | Commitment (C5): the host of `graft start` contains only the kernel. |
| P2 | Module resolution returns a transferable module or artifact descriptor. |
| P3 | Environment services are provided per unit. |
| P4 | intercept becomes configuration or a module inside the unit. |
| P5 | Loader structural grouping is separated from deployment groups. |
| P6 | Entries go into Workers by default. |
| P7 | Derived from local service edges, as a fixpoint over the old and new groupings. |
| P8 | Structural child instances are handled. |
| P9 | An ordinary failure inside a group restarts only the related members. |
| P10 | Terminating a whole group reports its impact truthfully. |
| P11 | Test fixtures move from closures in `fromRecord` to module fixtures. |
| P12 | The release plugin runs in its own unit and records and acknowledges through the public protocol. It refuses self-replacement when no handover capability exists (6.3). |
| P13 | In-process mode: documentation and boundary. |
| P14 | Deleted: host plugin special cases, and the path where the Loader activates entries in the host. |
| P15 | Acceptance: closure and placement conflicts when groups split or merge; partial view acknowledgement failure, and late acknowledgement. |
| P16 | Acceptance: a failure inside a group restarts only the related members; when the release plugin crashes, or is asked to replace itself, its recording obligations follow the rules. |
| P17 | Acceptance: the host process imports no plugin or contract module; the first-release gateway scenario is re-verified. |

| Task line | Controlling project decision |
| --- | --- |
| U1 | Unreleased packages: no backward compatibility, and no adapters. Each step deletes what it replaces, together with its tests. Behavior still wanted becomes acceptance tests for the new mechanism, recorded in a deletion manifest. |
| U2 | The kernel runs no plugin code; isolation and reclamation work by termination. The decision core stays pure, and all status is a projection of it. |
| U3 | Third-party plugins get the same path as first-party ones, with no privileged route. |
| U4 | Supervision, restart intensity, `Graft.replace`, HMR removal and Loader edits as Changes belong to Phase 4. Release journals belong to Phase 5. Name these as non-goals; do not design them here. |
| U5 | New public behavior ships with three-language docs (en, zh-cn, zh-tw), per `packages/docs/STYLE.md`. |

| Area | Phase 3 delivery | Limit / source |
| --- | --- | --- |
| Decision core | Extend the existing reducer with group membership, complete closure, per-member facts and control-plane obligations. | No second planner with independent admission authority or mutable status mirror (U2; S:43–111). |
| Loader | Convert configuration structure to deployment data; resolve and inspect outside the kernel; activate entries only through kernel-controlled units. | Initial load and explicit public deployment submissions; automatic editing/retry policy is not this phase (P2–P6, P14; U4). |
| Groups | Realm-resolved local edges, explicit co-location, old/new closure, whole-unit replacement and member-local ordinary failure handling. | No automatic application-wide grouping; dependency inference is the provisional default, pending the value experiment (V:149–168, 295–300; A:107–115). |
| Control plane | A release plugin unit using the same public submission, observation and recording protocol available to other plugins. | Runtime-lifetime ownership only, subject to O4; no release batch/journal implementation (A:475–477, 515; P12; U3–U4). |
| Embedded use | Preserve composition and cooperative lifecycle inside units and directly embedded applications. | No embedded Change outcomes, isolation or termination-based reclamation (A:119–127; S:25, 29–41). |
| Public surface | Replace the singleton-only deployment representation and publish the resulting supported behavior in all three languages. | No aliases or adapters; export every type in public signatures (U1, U5; D:13–20, 100–111; AGENTS.md:28–29). |

## Current implementation and discrepancies

These are migration inputs, not permission to preserve conflicting behavior.
The architecture's “today” inventory predates Phase 2; use E for what now
exists, rather than treating A:605–612 as a fresh code audit.

| Evidence | Existing behavior | Required change |
| --- | --- | --- |
| E:11–15, 34–52; `packages/core/src/internal/decisionCore.ts:1095–1131` | Production decisions are pure, but admission rejects multiple members and local dependencies. | Extend this reducer and its exploration; remove the singleton rejection only with group acceptance evidence. |
| `packages/core/src/internal/decisionState.ts:67–76, 233–251, 275–300` | Description has a member count; Unit has one instance/term; conclusions have one ExplicitTarget member. | Represent identified members, their generations/reasons and unit membership explicitly. A count cannot establish closure or collateral impact (A:207–221, 314–327, 393–405). |
| `packages/loader/src/ModuleResolver.ts:70–85, 314–363, 471–491` | Resolution imports and returns a Plugin; `fromRecord` stores live Plugin values. | Transfer descriptors; import/check in preparation units; replace closure fixtures (P2, P11; A:87). |
| `packages/loader/src/Entry.ts:55–79`; `Group.ts:369–424, 471–478`; `Loader.ts:141–157, 189–190` | Structural groups recursively activate entries with `Graft.plugin`; updates reach embedded forks. | Keep structural identity/configuration semantics as data, remove this hosted activation route (P5, P14). Paths in this row are under `packages/loader/src/`. |
| `packages/loader/src/Intercept.ts:25–50, 73–84`; `packages/cli/src/Start.ts:113–150, 184–197` | Schema/merge closures and ambient layers are supplied by the host. | Serializable patches or unit-loaded modules, with services rebuilt per unit (A:91; P3–P4). |
| `packages/cli/src/Start.ts:22–40, 83–108, 142–175` | `start` installs embedded Application/Include/reloader plugins and HMR. | Replace the composition root; keep legacy edit/HMR work outside this new path until Phase 4, subject to O6 (P1, P14; U4). |
| `packages/cli/src/bin.ts:148–169`; `internal/commandHost.ts:50–81, 120–150` | The executable builds Graft and discovers/activates command plugins before dispatching `start`. Changing Start alone leaves host plugin execution. | Dispatch the built-in start path before command-plugin discovery and keep that plugin host outside its runtime import graph (A:87–101; P1/P17; O6). The second path is under `packages/cli/src/`. |
| `packages/plugin-remote/src/internal/kernelMain.ts:13–46`; E:98–115 | A fixed data-only kernel executable and a public gateway slice already exist. | Reuse their boundary and extend it to the actual CLI start import graph; do not substitute another demonstration executable for CLI acceptance. |
| `packages/plugin-remote/src/Units.ts:9–30`; `internal/unitProtocol.ts:22–62`; `internal/nativeUnit.ts:185–208, 291–325` | Remote describes and serves one plugin/contract, with `members: 1` and one unit-wide term. | Multi-member descriptions, per-member terms and scopes, plus local-only plugins without a fabricated contract. Paths after the first are under `packages/plugin-remote/src/`. |
| `packages/plugin-release/src/index.ts:1–3`; `internal/journal.ts:17–23, 133–151` | Public release surface is models/build; the retained journal validator permits one pending intent. There is no current running release plugin to relocate. | Introduce the ordinary unit plugin; do not resurrect a host service or use this journal as the new coordinator (P12; U4). The second path is under `packages/plugin-release/src/`. |
| `packages/plugin-remote/src/internal/controlProtocol.ts:215–253`; E:628–640 | Public control supports singleton submission/query/cancel, but no recording-owner acknowledgement protocol. | Extend public codecs/client/server with core-owned obligations; transport mailboxes remain transport state (A:475–477; O4). |

## Open decisions for the owner

Architecture rules determine the invariants below but do not specify these
mechanisms or resolve these phase boundaries. Approve or replace each
recommendation before its dependent step. A replacement must update the affected
fault cells and evidence, not leave an implementer to invent a fallback.

| Id | Silence or conflict, with source | Recommendation and implementation gate |
| --- | --- | --- |
| O1 | A:87, 91 and P2–P5 require data boundaries but do not define the Loader bootstrap, transferable declaration format, or how Describe discovers structural children without apply (A:327; S:160–169). | Use a dedicated Loader control unit bootstrapped from fixed descriptor data. Add static, module-addressed child declarations to the unit description: parent id plus declaration name, module/artifact, input, realm, services, resources and placement requirements. Describe recursively validates these without apply. Configuration containers are not instances. Actual children created in a parent's Scope must be predeclared and co-located with that parent in this phase; report that explicit structural constraint. Reject cross-unit Scope children rather than invent remote Scope semantics. Independent entries nested in Loader containers may occupy different units. This child co-location restriction needs owner approval; it is not stated in A:322–327. Gates steps 1–3. |
| O2 | A:108 permits explicit groups and inferred groups, but does not say whether an explicit group is an exclusive boundary when a local edge reaches another group, nor define group identity across a split. | Treat explicit groups as co-location constraints, not permission to break local edges. Union overlapping explicit constraints and local components; display every expansion. Unequal explicit placement requirements reject the plan, including distinct runner destinations/security profiles. Give each group membership an opaque, versioned core identity; splitting/merging creates new identities and reserves old and new membership cells. Never infer identity from a structural group name. Gates step 2. |
| O3 | A:333–343 defines per-member strategy and whole-group overlap eligibility, but not strategy arbitration across several old/new groups in one closure. | Use one strategy for a single connected replacement closure in Phase 3: default Restart; explicit Overlap only if every moved member, resource combination and placement supports it. Reject an explicit ineligible Overlap; do not silently weaken it. Execute dependency-ordered waves, retaining per-member results. This is a deliberate narrower policy than arbitrary mixed-strategy batches, which remain Phase 5. Gates steps 2–3. |
| O4 | A:462, 475–477 requires recording/acknowledgement and stopping on recording failure; P12 requires it now, while U4 and S:429 defer journals. A does not define acknowledgement gates, authentication, or the terminal result of a permanently lost recorder. `Stuck` means missing exit evidence (A:389), not missing storage acknowledgement. | Implement the runtime-only recording barrier described below through a public protocol. Records live in the release unit's memory; the kernel retains the immutable record payload and unsatisfied obligation until acknowledgement. No durability claim. Recording loss blocks dependent forward actions and successful completion, while safety settlement continues; expose a nonterminal recording-blocked fact, never mislabel it Stuck. A real missing unit exit still produces Stuck. No recorder handover or automatic replacement in Phase 3. This bounded-memory, potentially nonterminal result is an owner decision, not a sixth outcome. Gates steps 4–5 and the recording fault rows. |
| O5 | A:112, 127 requires ordinary member restart inside the unit; A:488 describes a supervisor restart as a Change; U4 defers supervision. The boundary is stated, but the member-report/attempt-grant protocol and Phase 3 retry trigger are absent. | Preserve the existing embedded cooperative mechanism and prove one ordinary failure/restart attempt, with per-member lifecycle evidence and fresh kernel-granted terms. Do not add a supervisor, retry schedule or intensity policy. While a Change owns the affected members, report/invalidate that Change and suppress a competing restart until it releases ownership. A failed attempt remains visibly failed; no new automatic retry policy. Gates step 3. |
| O6 | P14 removes hosted Loader activation now, but U4 defers Loader edits as Changes and HMR removal. The current CLI couples all of them (`Start.ts:113–175`), and command discovery precedes start (`internal/commandHost.ts:120–150`, under CLI). | Make Phase 3 `start` load one configuration revision through the new Loader unit, without command-plugin discovery. Reject `--watch` and live Loader mutation against that deployment with an explicit unsupported diagnostic; never route them to the old embedded engine. Retain unrelated HMR/embedded APIs until Phase 4, without importing them from `start`. Non-start command plugins are explicit embedded use: their composition root may import a resolved descriptor, but cannot use a retained Plugin-valued resolver adapter or enter the kernel path. This temporary CLI boundary requires owner approval and three-language docs. Gates steps 1 and 5. |

## Loader and preparation boundary

The following mechanism uses O1 and O6. The host reads fixed CLI/bootstrap data,
installs the kernel/placement/control layers and starts the Loader unit. It
does not import Include, plugin-defined configuration, intercept registries or
business contracts. Fixed platform services needed by the kernel itself are
allowed; the ban is on executing application code, not on the kernel reading a
bootstrap file (A:87–101; `internal/kernelMain.ts:13–43` under Remote).

Bootstrap the Loader and release units through the fixed unit mechanism, not by
running their plugin exports in a special host phase. The Loader proposes initial
instance data through public control; the core validates and admits it before
any entry Serve. Initial creation and declared child add/remove must be supported
by that data model, although translating subsequent file edits into Changes is
deferred. Bootstrap authority/grants are explicit deployment data; business
callers cannot acquire them by naming a first-party package (A:87, 207, 318,
327, 515; S:427; U3–U4; O1/O4).

| Boundary | Data or behavior required | Source |
| --- | --- | --- |
| Configuration tree | Loader reads one revision, resolves include-relative directories, persists/validates stable entry ids before submission, applies disabled/selection rules, and flattens structural containers into instance descriptions. Inherited realms and intercept configuration stay attached to descendants; a container alone creates neither an execution member nor a deployment affinity. | P5; A:109, 207; existing `Entry.ts:30–38, 55–79, 98–119` and `Group.ts:504–509` under Loader; O1/O6. |
| Resolution | A result contains module location/export or immutable artifact identity, resolution base and provenance, not a Plugin, function, Context, Schema or Layer. Preserve exact-name precedence, equal-rank short-name ambiguity, relative-path context and missing-versus-broken-module diagnostics in module fixtures. Any check that needs import runs in a disposable unit. | P2/P11; A:87; `ModuleResolver.ts:94–102, 208–216, 351–461` under Loader. |
| Stable bytes | A module descriptor is a resolution result, not permission to execute a mutable working directory. Capture/verify the module closure before serving; record uncaptured external runtime dependencies. Share existing Artifact/Publication facilities. No new hot-reload pipeline here. | A:519, 548; S:137–177; U4. |
| Environment | Build FileSystem, HttpClient, clock, logger and declared custom environment modules in each unit. Transfers contain encoded options/references and immutable module identities only. Secret references resolve under current policy; recovery resolves again. An environment service is unit-provided infrastructure, not a synthetic application provider that merges all entries. | A:91, 409–412; V:162–168; S:171–177, 226–230. |
| Intercept | Transfer ordered inherited patches or an immutable module descriptor; load the reference, decoder and merge code inside Describe/execution units. Include their identities/options in validation-environment identity. Reject unregistered keys, invalid patches and executable input values; no host callback escape hatch. | A:91; P4; S:171–173; `Intercept.ts:25–50, 73–84` under Loader. |
| Description | Return identified members, resolved declaration names, local versus contract provides/requires, optionality, realm inputs, children/resources, placement requirements, overlap eligibility and probes, tied to artifact/config/environment/protocol identity. Local-only members need no dummy RPC contract. | A:107–113, 207, 314–342; O1; current limitation `nativeUnit.ts:170–207` under Remote. |
| Validation | Describe does not apply plugins or acquire serving/exclusive resources. Inspect under the selected trust boundary; require its exit before admission. Serve rechecks the same declarations; mismatch or undeclared conflict stops this attempt and requires a new plan after settlement, never incremental locking. | S:143–177; A:327, 433–437. |

Custom resolver/environment/intercept code follows the same immutable module,
preparation, trust and termination path as any third-party code. Code in a
Loader control unit is not permission to execute candidate imports there without
the disposable preparation boundary (A:87, 99; S:137–169; U3).

## Group planning and admission

Planning runs on immutable encoded facts in the production decision core (or a
pure module called by it). Loader supplies declarations and intent, never an
authoritative closure, reservation or status. Index dependencies, parents,
memberships and absence versions so replanning an affected region does not scan
unrelated instances. Initial loading may inspect the complete submitted input;
an unrelated running application's size must not enlarge a later Change's
footprint (A:27, 431–451; S:48–74, 105–111; E:116–124; U2).

1. **Resolve** old and proposed service graphs by realm to concrete provider
   instances. Record each consulted slot/version, including optional absence.
   Local and contract edges are distinct; equal textual keys in different realms
   do not join instances. Validate exact operation subsets/provenance for
   contracts; a compatible contract consumer stays outside the replacement set
   unless another reason selects it (A:107–111, 319–325, 432; S:240–249).
2. **Derive** each grouping separately from its local edges plus explicit
   co-location constraints (and O1's approved Scope-child restriction). Take
   undirected connected components for placement; retain edge direction for
   lifecycle ordering. Structural Loader containers add no edges. Each component
   gets one placement: Worker if unconstrained, otherwise its single compatible
   explicit requirement. Reject conflicting requirements before serving work;
   never move an untrusted member to Worker to satisfy co-location (A:95–115;
   P5–P7; O2).
3. **Close** from explicit changed/added/deleted instances. Repeatedly add every
   selected instance's old-group and new-group members, old/new structural
   descendants, consumers capturing changed local values, and consumers whose
   required contract loses a compatible provider. Continue until no addition
   occurs, reapplying group expansion after every descendant/dependency addition.
   Removed instances have only old membership; new instances have only new
   membership. Keep all selection reasons and predecessor edges, not just the
   first reason (A:113, 314–327; S:427).
4. **Validate** placement, required providers, cycles, child declarations,
   resource compatibility, strategy eligibility and total budget for this full
   closure. A missing required provider cannot yield Serving. Compute inspection,
   forward and recovery capacity from distinct unit incarnations, including
   pending spawns and unconfirmed exits; do not charge a shared unit once per
   member or assume a split costs one slot. Display old/new groups, reasons,
   strategy, stop order, recovery target and all collateral termination members
   in the plan (A:314, 327, 340–343, 376; S:62, 143–177; O3).
   Reserve the peak simultaneous unit count of the chosen forward/recovery
   schedule, including its inspection work. Overlap needs old plus new groups
   concurrently; Restart may reuse old slots only after exit evidence. Recovery
   reservations cannot be borrowed by another Change (S:62, 171–177).
5. **Reserve** all instance, old/new membership, binding, dependency, resource,
   authorization and recording-owner premises together. Check expected versions
   including tombstones in one short core transition; reject stale or Busy with
   concrete conflicts. Required participants are the affected endpoints and
   derivation owners, not all units. No remote wait occurs in admission. Discovery
   outside the reserved footprint settles staging and demands resubmission
   (A:327, 431–464; S:78–111; O4).

The fixpoint is a replacement closure, not the new grouping itself. For example,
old `{a,b}`, `{c,d}` and new `{a}`, `{b,c}`, `{d}` select all four when `a` changes:
old `a` adds `b`, new `b` adds `c`, old `c` adds `d`. The new deployment still has
three groups. A compatible external contract consumer `g` stays outside; a
declared child of `d` enters and triggers expansion of its groups too. A one-pass
union or permanently merging the four into one group is wrong (A:113, 319–327).

## Execution, views and residual ownership

Use the existing interpreter, preparation owner, encoded direct channel and
single-hop completion protocol. Replace singleton records rather than wrapping
one singleton Change per member: shared old-unit exit and atomic complete
admission must have one owner (S:57–66, 117–124, 184–230; E:11–15, 34–52; U1).

| Object / transition | Required behavior | Source |
| --- | --- | --- |
| Group unit | One native handle, capacity claim and exit observer; explicit map of member instance/generation/term to scopes and endpoints. Each activation receives a fresh term from the kernel before execution, including cooperative attempts in the same unit. Never use one term or one health bit for every member. | A:207–221; U2; O5. |
| Startup/stop | Start providers before consumers; stop dependent consumers and release their leases before providers. Keep unrelated member scopes alive for ordinary failures. Code/config replacement uses new units for the complete closure; merely closing scopes does not unload code. | A:89, 112, 127, 336–342. |
| Strategies | Under O3, Restart drains/stops all old units needed by the closure before resource reuse, then starts new groups in dependency order. Overlap starts the complete eligible new closure before switching and retiring old groups. Recovery uses old desired topology/configuration, fresh references and current trust, exclusively where necessary. | A:333–364, 409–412; S:226–230. |
| Views | Stage only the closure's patch. Install candidate startup routes before Serve where required; lifecycle/derivation traffic cannot wait on paused business admission or its own publication. Acknowledge exact authority, Change, participant unit incarnation, member generation and view. Commit only when every necessary participant has installed/derived it and local versions still match. | A:436–443; S:78–81, 242–245. |
| Contract semantics | Co-location does not turn a contract into a raw local service. Preserve the same encoding, typed errors, cancellation, provider Context and owned completion when its endpoints share a unit; ordinary local services remain unencoded. Published plugins use contracts except for explicitly bundled/private application composition. | A:107, 241–248, 255; V:164–168; S:234–259. |
| Partial or late installation | On failure before commit, discard only this Change's staging and settle its candidates. Late/duplicate/wrong-generation acknowledgements cannot activate or restore a view. After commit, a failed participant is unavailable; it cannot roll itself back. Existing admitted calls remain pinned. | A:437–439; S:121, 243–249. |
| Ordinary group failure | Report exact failed generation/cause; withdraw its invalid bindings and restart only the failed member plus dependent/Scope-owned members whose lifetimes were invalidated. Healthy unrelated co-residents retain generation, scope and resources. A compatible contract relationship alone does not require restarting its consumer. This is an embedded lifecycle action, not a fabricated kernel Change outcome. | A:112, 125–127, 324–325, 504–509; O5. |
| Failure during a Change | Planned withdrawal belongs to that Change; external loss invalidates its premises. No competing cooperative attempt may acquire the same member ownership. Settle candidates, then recover under current dependency/trust facts or report failure. | A:355, 466–467, 504–509; O5. |
| Whole-unit termination | A stuck member finalizer can require termination of the shared unit. Report every hosted member as affected, including healthy collateral members; any changed external dependency is invalidated too. Required unit exit settles all its members' runtime execution/leases once, but never asserts successful finalizers. | A:218–221, 364–379, 499–509; S:184–222. |
| Missing/late exit | Retain exact unit, call/lease, capacity, reservation and observer owners; Stuck blocks only conflicting work. Late exit settles only the original incarnation's claims; immutable conclusions remain unchanged. | A:389, 444; S:191–200, 351–355. |
| Public facts | Each planned member has starting/desired/actual state, every selection reason, execution/compensation evidence and recoverability; expose planned versus actual whole-unit impact. Get/events/outcome snapshots derive from the same core facts. Release/Loader may render them, not maintain authoritative copies. | A:393–405, 559–566; S:68–74; U2. |

Mixed member outcomes never disappear behind a group label. Failed closure work
stops dispatching unstarted members, settles in-flight work including late
success, and recovers only owned versions in reverse dependency order; unrelated
accepted changes remain intact. This is necessary group settlement, not the
Phase 5 release-batch/history API (A:404–412, 466–467; U4). Any required missing
exit takes precedence as Stuck; otherwise apply S:210–230's Accepted, Aborted,
Recovered and RecoveryFailed conditions to the closure's full member facts.

## Release unit and recording obligations

This section is the concrete O4 recommendation. It does not silently choose a
durable journal design. The release plugin is built and bootstrapped as an
ordinary separately placed unit; a third-party control plugin can use exactly
the same protocol with equivalent grants. The kernel imports only fixed control
codecs, never release schemas, storage callbacks or plugin exports (A:87, 515;
P12; U3–U4).

| Stage | Protocol and ownership rule | Basis |
| --- | --- | --- |
| Register responsibility | Bind a recording role to an authenticated unit incarnation and permitted operation scope. Store that grant and the active obligations in the core. Deployment policy specifies which operations require that recorder; a request cannot omit or downgrade those duties. A requester cannot name an arbitrary recorder and create authority; no magic release package-name check. | A:87, 475–477; U3; exact mechanism O4. |
| Admit | Stable request key/content maps to one Change/preparation as in Phase 2. The Change, command fibers and exit observers belong to the kernel, not the submitting plugin's Scope. Register required record obligations before dispatching dependent actions. | A:418–422, 475–476; S:143–158, 280–285. |
| Record and acknowledge | Send an immutable payload and token containing authority, Change id, record sequence/content identity, phase and owner incarnation. The unit stores it before acknowledgement. Retried delivery of the identical record is idempotent; it is not permission to resubmit the business Change. Reject wrong payload, owner, incarnation or phase. | A:437, 462, 475–477; exact record envelope O4. |
| Gates | Require acknowledged intent before affected lifecycle actions, acknowledged commit decision before route activation, and acknowledged concluding member facts before reporting successful recording/completion. Safety stop/termination/exit observation never waits for the recorder. A blocked commit has not activated; a blocked conclusion may already have a serving target, which observation must show. | Causal order A:462; failure rule A:477; placement of gates and safety exception O4. |
| Failure or crash | If an ordinary submitting plugin disconnects without recording duties, admitted work continues. If an obligated recorder fails, freeze dependent forward work, retain the outstanding immutable records, ownership and actual facts, and report the original cause. Do not auto-ack, cancel ownership with the plugin Scope, roll back a committed view, or report Accepted. Unrelated Changes with no dependency on that recorder can progress. | A:418–422, 437, 444, 476–477; O4. |
| Same owner reconnects | Query by stable id and replay outstanding record requests to the same live owner incarnation; a matching late acknowledgement discharges that obligation once. Recheck current premises and the original total deadline before any progression. Acknowledgement cannot reset budgets or resurrect a stale view. | A:437, 475; S:121, 143–158, 354–356; O4. |
| Recorder actually dies | Retain its unsatisfied duties even after its unit exit settles execution/capacity. A new incarnation has no implicit handover authority. In this phase it cannot acknowledge the dead owner's duties; expose recording-blocked state for operator diagnosis. Kernel process loss loses these in-memory records. | A:218–221, 476–477; S:197, 285, 429; O4. |
| Bounds and expired budget | Reserve bounded record count/bytes and control queue capacity before admitting work requiring a recorder; reject excess new work rather than evict an obligation. A blocked record does not extend the absolute Change budget. Expiry stops forward work and settles execution under the existing failure rules; outstanding recording remains observable even if execution has settled. Late ack can clear a record, never revive expired forward work. Terminal failure evidence, including Stuck, may be published with incomplete recording explicitly attached; Accepted requires its recording duties satisfied. | S:123, 250, 280–285, 356; A:477; exact storage bounds and failure/recording separation O4. |
| Self-replacement | Before admission reject a target whose full closure or required whole-unit termination includes any owner needed to record/acknowledge this Change. Check the release unit even if selected only by merge, local dependency or parent closure; rejection allocates no Change id or stop command. Recheck against existing obligations when another caller targets that unit. No caller-supplied “handover=true” bypass exists. | A:113, 327, 451, 476; P12; no handover capability is implemented here. |

An obligated recorder is protected against planned stopping, not immortal: a
native crash, forced safety termination or kernel shutdown can still kill it.
Report the resulting missing recording facts separately from execution evidence.
If it has no duties for a later operation and no older outstanding obligations,
the same unit may be replaced by another authorized client through the ordinary
path; do not create a permanent first-party exemption (A:476–477; U3; O4).

## Invariants and counterexamples

Phase 2 invariants remain in force, generalized from singleton to identified
members. Each row adds an acceptance obligation (S:342–357).

| Id | Invariant | Counterexample the tests must reject | Source |
| --- | --- | --- | --- |
| I1 | Kernel imports/execution are fixed protocol only. | A Loader resolver, config refinement, intercept merge, gateway or release plugin runs on the host event loop. | A:87–101; P1–P4. |
| I2 | Structural containers and deployment groups are different relations. | Nested YAML entries share a Worker merely because they share a Group node. | P5; A:107–115; O1. |
| I3 | Concrete realm-resolved local edges determine co-location. | Equal keys in different realms merge; a local value crosses units; compatible remote consumer is forced into the group. | A:107–111, 324–325. |
| I4 | Closure reaches a fixpoint over both groupings and structural/dependency additions. | Splitting `{a,b}` changes only `a`; merging brings only selected members of an old group; child's group is omitted. | A:113, 319–327. |
| I5 | Complete reservations, versioned patches and local participants precede execution. | Runtime child silently adds a lock; failed partial install activates; A's commit erases B; late ack reactivates an old view. | A:327, 431–451. |
| I6 | Ordinary failure and unit death have different impact. | One cooperative member failure restarts unrelated co-residents; a whole-unit kill reports only the failed member. | A:112, 127, 376. |
| I7 | Member generation ownership and unit execution ownership remain distinct. | One member's Scope close frees shared unit capacity; duplicate exit frees it twice; an old report changes a new member generation. | A:207–221; S:351–355. |
| I8 | Control duties survive submitter loss and gate dependent actions. | Recorder crash produces success; socket delivery is treated as stored acknowledgement; fresh incarnation clears old duties. | A:475–477; O4. |
| I9 | Self-replacement checks the complete impact closure, without privileges. | Release replaces itself indirectly through a merge; a third-party recorder bypasses checks or is denied the public protocol. | A:451, 476, 515; U3. |
| I10 | Public facts come from the core and preserve scope limits. | Loader/release caches fabricate an outcome; embedded restart claims Change isolation; forced exit claims successful cleanup. | A:125–127, 219–220; U2. |

## Fault table

Each row is a required cell, not an example. “Released” concerns this operation's
claims only; serving units keep normal capacity/leases. Every cell asserts exact
member generations, selected reasons, actual health, reservations, calls, units,
recording duties and causes through public observation. Missing-exit rows
override ordinary outcome rows. Recording-blocked rows are conditional on O4;
they must not be reported as passed acceptance before that decision is made
(S:359–388; A:393–405, 475–477). Other rows assume required recording gates
succeed; a recording fault overlays those execution facts and prevents Accepted
until its own duties are satisfied (O4).

| Cell / injected fault | Expected outcome or observable state | Residual objects | Evidence / source |
| --- | --- | --- | --- |
| F1: conflicting placement after split/merge closure; missing provider; cycle; explicit ineligible Overlap; stale premise; Busy or capacity rejection | Rejected before admission, no Change id or old stop. | No Change reservations; only separately owned unfinished preparations if any. Old units remain serving. | Full old/new closure, conflicting edges/versions/placement and preparation query; A:110–113, 327, 340–343, 433–434; S:370. |
| F2: resolver/import/config/intercept Describe fails or blocks | Reject after bounded termination attempt; never activate entry in host. | Confirmed exit releases preparation claim; missing exit retains preparation id, unit, capacity and observer, not an admitted Stuck Change. | Block each executable preparation boundary; S:143–177, 371. |
| F3: Serve declaration differs; undeclared child/resource lies outside footprint | Stop/settle staging and require fresh planning. Aborted only if old remains usable; otherwise recovery classification applies. | No added reservations; candidate objects until exit; then only serving/recovery claims. | Description identity and refused child/resource registration; A:327; S:160–169, 210–230. |
| F4: one necessary view participant rejects or never acknowledges before commit, old unchanged | No activation; Aborted after candidate exits if old remains healthy/authorized. | Old routes live; this Change's staging removed; candidate claims only until exit. B's staging/commit untouched. | Required participant set and install/active tokens; A:437–439; S:386. |
| F5: same partial installation failure after Restart stopped old | No stale view restoration; Recovered after fresh old-topology recovery and full trial, or RecoveryFailed if it fails with exits confirmed. | Failed units released; recovery units serving, or actual unavailable with desired facts retained. | Old/candidate exits, fresh grants, recovery member facts; A:355, 362, 409–412; S:215–216. |
| F6: wrong/late/duplicate view acknowledgement after abort, recovery, newer view or same-name recreation | No new activation or outcome rewrite; accept only evidence for its original obligation. | New owners untouched; any original outstanding staging/exit obligations remain until properly settled. | Replay every token dimension and both A/B commit orders; A:437; S:121, 382, 386. |
| F7: participant fails after committed patch | Mark affected binding unavailable; never autonomously roll back. During trial, fail/recover the owning Change; afterward retain current failure facts. | Existing pinned calls/cleanup retain ownership; unaffected routes and members remain. | Committed view plus failure/generation evidence; A:437, 496, 504–509. |
| F8: ordinary member `p` fails in group with local dependent `q`, Scope child `s` and unrelated `r` | One cooperative attempt restarts `p/q/s`; `r` and the unit retain identity/resources. No kernel Change outcome invented. | Failed generations end after cooperative cleanup; unit claim remains; fresh affected generations/leases replace only their own. | Barrier-driven generation/resource counters and public member reports; A:112, 127, 342, 364; O1/O5. |
| F9: F8 cleanup hangs, whole group termination is required | Report all hosted members, including `r`, stopped/unknown. An owning Change follows Recovered/RecoveryFailed after exits; with no Change, report unit/member failure without inventing one. | With exit, all unit execution/leases release once; cleanup may be unknown. No automatic whole-group recovery supervisor is promised. | Native exit and collateral member list; A:218–221, 376; U4. |
| F10: whole old group retirement stalls after Overlap target passes trial; forced exit confirmed, no known required cleanup failure | Accepted with forced-retirement/unknown-cleanup facts for every old member. | Old unit execution claims released; all target groups serving. | Native old exit and target Serving/trial evidence; S:219–222, 379; A:220. |
| F11: required group/child/candidate exit missing; runner disconnect or termination ack only | Stuck after evidence deadline; never infer death. | Exact unresolved incarnations, member leases/calls, shared unit claims, conflict reservations and exit observers retained; unrelated B can progress if capacity permits. | Missing evidence and independent public B submission; A:218, 375, 389, 444; S:381, 385. |
| F12: late/duplicate group exit after Stuck and recreation | Original Stuck unchanged; current residuals settle once for all members of that old unit only. | Old settled claims released, newer membership/terms untouched; unsatisfied recording duties remain separate. | Exact old ownership tokens and public projections; S:191–200, 382; O4. |
| F13: candidate startup/trial failure in one of several new groups | Stop unstarted work and settle all started candidates, including late success. Aborted only if no old member changed and all old service remains usable; otherwise Recovered after complete recovery requirements. | No orphan split-group unit; recovered groups instance-owned; unrelated accepted state intact. | Per-member execution and reverse-dependency recovery trace; A:355, 393–412. |
| F14: recovery denied by current trust, unavailable dependency, lost owned version or failed recovery | RecoveryFailed after all required exits; no overwriting B or reviving revoked permissions. | Desired target and actual unavailable/mixed member facts retained; failed execution claims released; full causes retained. | Fresh policy/resolution/version evidence; A:409–412, 466–467; S:375. |
| F15: release submitter disconnects without outstanding recording duty; waiter cancelled | Admitted Change continues; stable key returns same id, same key/different content rejects. | Core owns Change, units and pending evidence; no duplicate execution. | Public reconnect/get/await; A:418–422, 475; E:628–640. |
| F16: recorder fails before intent ack, before commit ack, or before concluding-facts ack (three separate injections) | Recording-blocked, not Accepted. Respectively: no affected lifecycle action; no activation; or actual serving state remains visible with completion unconfirmed. | Original Change/reservations, pending record payload/token, in-flight safety settlement and actual unit claims retained. | Protocol barriers and action-dispatch trace for each gate; A:462, 476–477; O4. |
| F17: recorder stores record but acknowledgement is lost; same live incarnation reconnects | Replay same record; matching ack discharges once. Progress only if current premises and original budget still permit; no duplicate Change or stale commit. | Pending duty until valid ack; other execution/reservation objects unchanged until ordinary settlement. | Store/delivery/ack barriers, duplicate and wrong-content ack; A:437, 475–477; O4. |
| F18: recorder crashes and native exit is confirmed, then a new incarnation sends an old acknowledgement | Execution exit is recorded; old recording duty remains blocked. Reject the new incarnation's ack without handover. If other required exits are missing, Stuck also remains visible. | Recorder's execution claim released; unsatisfied duty, payload, related Change reservation and actual member facts retained. | Distinct unit incarnations, no implicit transfer; A:218–221, 476–477; O4. |
| F19: direct self-replacement, indirect selection by group/child closure, or another client stopping a recorder with outstanding duties | Reject before admission/Stop; do not grant a bypass to release or another first-party plugin. | Recorder/old deployment stays live; existing duties remain; no new Change claim. Preparations settle normally. | Full impact closure and authenticated duty owner; A:451, 476; P12; U3. |
| F20: ordinary member failure races a Change that owns it | Invalidate that Change; no competing restart attempt. Settle/recover under current dependencies or report RecoveryFailed/Stuck as evidence warrants. | Only current owner may advance affected versions; unrelated members/Changes remain live. | Deterministic report orderings and grant trace; A:504–509; O5. |
| F21: group drain has result/cancel but outstanding owned cleanup | Drain stays outstanding until completion or provider unit exit; whole-unit exit settles all its matching credits. | Session/member-qualified credits and leases retained; no automatic business retry. | Existing single-hop tests generalized to two members sharing a unit; S:245–259, 384–385. |
| F22: CLI shutdown while group execution or recording is unresolved | Close admission; settle/terminate owned units. Stopped service reports RecoveryFailed, missing exit Stuck; missing records remain explicit, never success. | Only unsettled execution/recording evidence owners remain until late evidence or kernel process end. | Shutdown barrier, immutable conclusions and residual query; S:195–200, 388; O4. |

## Implementation order and deletion manifest

Every step replaces its old mechanism and tests in the same change. Record each
removed file/export/test case in `design/phase-3-deletion-manifest.md` with old
behavior, retained/replaced/deleted/deferred disposition, new acceptance test id
and reason. A deferred behavior is not an executable compatibility stub. Keep
embedded-only tests as embedded evidence, not proof of kernel isolation
(U1; S:287–291, 410–413; E:128–142).

| Step | Build and delete together | Required exit evidence |
| --- | --- | --- |
| 1 | After O1/O6, define data descriptors and a Loader preparation path using existing artifact/inspection facilities. Replace `ModuleResolver`'s Plugin-valued return/importer path and `fromRecord`; move resolution/environment/intercept cases to real module fixtures. Remove host-facing configuration callback assumptions; retain unit-local Effect composition. | F2 and descriptor serialization; resolution precedence/ambiguity/missing dependency, relative include base, intercept inheritance/invalid patch and fresh reference recovery tests. No host import is used to make these pass (A:87–91; P2–P4, P11). |
| 2 | After O1–O3, add pure graph/group closure, identified descriptions and per-member projections to decisionCore and public control data. Replace singleton fields/rejections with the complete reservation model. Delete “groups unsupported” cases only as their replacements land; keep unsupported call-topology cases. | I2–I5, F1/F3/F6; split→merge multi-iteration closure, realms/absence ABA, child expansion, conflict/placement and real index-access locality tests (A:107–115, 327, 431–451). |
| 3 | Extend native unit lifecycle, environment construction, member reports/terms, shared exit accounting and staged views. After O5, integrate cooperative member restart. Remove single-member native bootstrap/observers and tests tied to its representation. | I6–I7, F4–F14/F20–F21 through reducer traces and real units; no extra singleton engines or host callbacks (A:207–221, 333–379; U1–U2). |
| 4 | After O4, add public recording-owner/grant/record/ack queries and reducer barriers. Build the ordinary release unit on this public protocol; replace any new-path reliance on retained release journal data. Do not implement journal replay, append storage or batch rollback. | I8–I9, F15–F19/F22; ordinary third-party recorder exercises exactly the same APIs. Record each ack crash window separately (A:475–477, 515; U3–U4). |
| 5 | Cut `bin.ts`/`Start.ts` over to fixed kernel bootstrap and Loader unit; dispatch start before command-plugin discovery and remove that host from its import graph. Remove Graft/Include/HMR/reloader/intercept host activation and the Loader Group→host-entry path. Remove associated host-special-case tests and replace wanted behavior with unit tests. Keep tree/storage helpers only where used by the new path or explicitly retained embedded APIs; no callable “legacy start” remains. | I1/I10, real CLI import audit including a configured command plugin, blocked-import/intercept fixture and first-release gateway acceptance. O6's unsupported live-edit/watch behavior is explicit (P1, P14, P17; U1/U4). |
| 6 | Finish the case-level deletion manifest, public exports and acceptance inventory. Update existing `units`, `control`, `loader-api`, `lifecycle` and release/artifact guides and affected sample READMEs in en/zh-cn/zh-tw alongside the steps that introduce behavior; this step audits parity, not postpones docs. | Every invariant/fault cell maps to a named test and residual assertion; no adapter/privileged route, complete public signature exports and matching language facts (U1/U3/U5; D:13–20, 100–118; S:410–413). |

Do not delete `Graft.replace`, the HMR package, embedded Update/ManagedFork or
design their successors here. Delete only the replaced `start`/host integration
and its dead dependencies. Retained release artifact/model/journal-validation
code is not migrated into a Phase 3 journal; remove any piece only when actually
replaced or dead, with its disposition recorded (U1/U4; S:427–429;
E:128–142; `packages/plugin-release/src/index.ts:1–3`).

## Evidence and enough bar

Existing evidence is E:11–52's reducer/interpreter/native foundation and
E:98–115's fixed gateway/import audit. It does not prove general Loader placement,
groups or recording duties. Phase 2's packed runtime remains explicitly
uncertified (E:3–7, 152–155, 801–814). This spec was drafted by static source
inspection only; no builds, tests or packed scripts were run for it.

Phase 3 is enough when all of the following hold, after the owner resolves
O1–O6. Missing decisions cannot be replaced by a passing narrow fixture.

1. **Core evidence:** production reducer exploration covers group fixpoints,
   old/new conflicts, member failure/Change races, acknowledgement permutations,
   recorder loss and exact late settlement. Report scenario bounds, state/trace
   counts and failing traces; no second oracle or fake internal Commit event.
   Instrument real index accesses while adding unrelated groups/Changes, not
   a self-reported scan counter (S:392–409; E:11–30, 116–124).
2. **Native evidence:** run actual Worker and process groups, with runner Restart
   and disconnect uncertainty. Use barriers and explicit completion/native exit
   signals for order. Demonstrate retained healthy co-residents on an ordinary
   failure and all-member impact on a forced group exit. A test guard timeout
   is not exit evidence (A:95–99, 112, 218–221, 343; S:397–404).
3. **CLI boundary:** audit the transitive runtime imports reachable from the real
   `graft start` branch, including package barrels and dynamic imports. A plugin
   and a contract fixture that fail if evaluated on the kernel thread, plus
   blocked import/decode/intercept execution in units, must leave public kernel
   queries responsive. Importing fixed executable modules remains inert.
   A textual search for `Graft.plugin` alone is insufficient (P17; A:87–101;
   E:112–115; AGENTS.md:27).
4. **Gateway value:** launch the first-release gateway via the new CLI/Loader
   path, with release in its own unit and a separately authored integration using
   public APIs. Repeat Overlap and Restart, held old unary call/new call, failed
   startup/trial recovery, current-trust recovery denial, and unrelated B progress
   during trial/Stuck. Assert unchanged gateway generation/upstream session,
   actual provider versions, every selection reason, old native exits and exact
   residuals. Add a local provider/consumer group split/merge without accidentally
   selecting the compatible gateway. No test adapter may supply privileged
   protocol steps (V:28–31, 241–245; S:262–285; E:98–110; P17/U3).
5. **Control-plane evidence:** F15–F19 separately prove submitter ownership,
   record-before-ack ordering, crash at every gate, same-owner late ack, wrong
   incarnation rejection and direct/indirect self-replacement refusal. A second
   control plugin uses the identical public API. Query shows actual serving
   members separately from missing recording completion (A:475–477; P12/P16;
   O4).
6. **Delivery evidence:** every I/F id has a named acceptance test with expected
   outcome/state and exact residual objects; every removed case has a manifest
   row. Public behavior and limits have matching three-language docs and samples.
   During implementation, run ordinary formatting, typecheck, test and build
   checks through devenv and record failures/platform exceptions separately.
   Do not execute `scripts/packed-*.mjs` under this task's authorization; packed
   runtime verification requires a separate owner-run result. No whole-system
   proof or new independent review loop is required by this plan (U1/U5;
   D:100–118; S:401–419; owner's execution restriction).

## Explicit non-guarantees

| Not delivered or not promised | Boundary / source |
| --- | --- |
| Supervisor, retry/backoff/intensity policy, general Committed reconciliation | Phase 4. Member-local cooperative restart acceptance does not introduce a kernel supervisor (U4; A:125–127; S:428; O5). |
| `Graft.replace` removal, HMR removal/replacement, Loader edits as Changes | Phase 4. O6 gates the temporary CLI restriction; no second host execution route is retained (U4; A:639–641). |
| Release journals/batches, durable request dedupe, persisted term high-water marks, kernel crash recovery or recorder handover | Phase 5 or conditional handover work. Phase 3 records are runtime-lifetime only; release unit death may leave recording blocked (U4; S:429; A:474–477; O4). |
| Embedded Change outcomes, isolation, forced cleanup or code unloading | Embedded mode is composition/dependency lifecycle/cooperative restart; code changes require process restart (A:125–127). |
| Arbitrary undeclared dynamic children or cross-unit parent Scopes | Must not enlarge admitted footprints. O1 proposes predeclared co-located Scope children; accepting more requires an owner-selected protocol (A:327). |
| Global atomic visibility/compensation, arbitrary mixed-strategy release batches | Local staged patches and truthful member facts only; O3 narrows closure strategy (A:404–405, 437–439; U4). |
| Streams, deferred/discard replies, nested cross-unit completion, general RpcServer request-scope drain or fabricated structured codec failure phases | Preserve Phase 2's encoded unary/single-hop support and explicit upstream limits (S:252–260, 430–431). |
| Bounded native kill latency, successful finalizers or reversal of external effects after forced exit | Exit evidence proves execution stopped, not successful cleanup or a business transaction (A:218–220, 370–379; S:219–222). |
| Worker as a security sandbox, universally portable native resources, measured best default grouping | Worker is a fault/reclamation boundary; placement must satisfy requirements. Dependency inference remains provisional pending workload evidence (V:162–168, 300; A:95–115). |
| Gateway session survival after its own group or kernel dies; durable application memory | Only the unchanged gateway's session is preserved. State migration, session continuation and kernel handover remain conditional extensions (S:434; V:194–197, 232–237). |
