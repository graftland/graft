# @graftland/plugin-otlp

## 0.6.0

### Minor Changes

- [`d213bfb`](https://github.com/graftland/graft/commit/d213bfb5619df1de05680b8a4eba4275fdb8e5ab)
  Thanks [@nmnmcc](https://github.com/nmnmcc)! - **Breaking:** Every runtime
  change is now a Change with a stable id, addressed by instance.
  `Graft.replace`, global plugin aliases, `@graftland/hmr`, `Loader.retry` and
  in-place updates under `graft start` are gone. Use Change requests
  (`Change.run`, the control client) for running applications and
  `graft start --watch` for saved code and configuration; a configuration change
  starts a new generation.

  **Breaking:** `graft start` hosts only the kernel. Plugins run in units
  (Workers, child processes or runners), grouped by local service dependencies;
  versioned contracts connect groups. Embedded `Graft.plugin` keeps composition
  and cooperative restarts, without Change outcomes or termination guarantees.

  **Breaking:** Core `Release` is now `Finalization`; `Manifest.Entry` and
  `Manifest.Host` are `EntryMetadata` and `HostProfile`; artifact identities and
  `Artifact.capture` use `module` instead of `entry`; `Trust.check` takes an
  instance and an attempt; `Projection.Change` is `Projection.Revision`; error
  classes carry their tag's name (`CapabilityDenied`, `ExtensionConflict`,
  `AdmissionRegistrationError`).

  - Changes: independent Changes run concurrently; each reports members, phase,
    execution evidence and one of `Accepted`, `Aborted`, `Recovered`,
    `RecoveryFailed` or `Stuck`. `Restart` drains and replaces; `Overlap`
    switches contract routes after readiness and probes. Probes a plugin
    declares in its `deployment` export run in every Change. A Change may
    complete at `Committed`: the desired state is validated and recorded, and
    the kernel reconciles in a linked Change.
  - Supervision: restart intensity with escalation, optional exponential
    backoff, and a reason when an instance is down (`Revoked`, `Escalated`,
    `WaitingForDependency`, `RestartPending`).
  - Trust: admission, recovery and supervision check current policy, so revoked
    targets never come back.
    `Units.target({ placement: "Process", confinement: "Sandbox" })` runs
    untrusted code under Linux bubblewrap and refuses to start it anywhere else;
    operators can require it per instance.
  - Releases: `@graftland/plugin-release` adds `plan`, `apply`, `observe`,
    `history` and `rollback` over Changes, a recorder unit with a durable,
    append-only journal (synced before acknowledgement), per-member facts, a
    diagnostics store with retention, and compaction. Request keys and
    unfinished Changes survive kernel restarts. Under `graft start`, an entry
    holds the recording role with `recording: { role }`.
  - Development: `graft start --watch` turns each save into a Change for the
    affected entries and replans when a conflicting Change ends. CommonJS and
    native addons run in Process units.
  - Contracts: notifications are delivered as unary pulls with explicit `Lost`
    and `Dropped` results; MCP tool descriptions need renewed approval when they
    change.

### Patch Changes

- Updated dependencies
  [[`d213bfb`](https://github.com/graftland/graft/commit/d213bfb5619df1de05680b8a4eba4275fdb8e5ab)]:
  - @graftland/graft@0.6.0
  - @graftland/loader@0.6.0
