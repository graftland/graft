---
title: Application releases
description:
  Build, check, apply and roll back immutable managed deployments in one
  application.
---

An **application release** is a content-addressed directory owned by
`@graftland/plugin-release`. Its `Releases` service updates named managed Worker
and child-process integrations through [execution transitions](../transitions/).

- The current release id advances only when every changed entry is `Accepted`.
- Configuration is decoded during planning; probes and trial run during apply.
- Startup selects the journal's last fully accepted release.

## Versioned content

| Content                 | Recorded in the release                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implementation packages | Complete captured directories, verified with [Artifact](../remote/artifacts/).                                                                              |
| Configuration           | Normalized `graft.yml`: entry ids, encoded input, contract module, direct placement and probe names.                                                        |
| Publication metadata    | Generated manifests and package-based provenance in `manifests.json`. Provenance is not compatibility.                                                      |
| Release manifest        | `release.json`: entries, capability/credential references and revocations.                                                                                  |
| Excluded                | Business data, resolved secrets, host plugins, host transition policy, and external runtime dependencies. External dependencies are not captured or pinned. |

Keep the store inside the application's dependency-resolution tree. Keep secrets
out of package files and literal configuration: the builder cannot identify
arbitrary secret literals. Use `!env NAME` or `{ "$env": "NAME" }`; the release
stores the name and resolves its value only in memory. Environment references
automatically enter the reference inventory as `env:NAME`. Other capability and
credential references must be listed explicitly. A rollback resolves references
again; it does not restore old secret values.

## Build a release

A release source uses Loader entry ids but accepts only managed Remote entries.
Package directories are relative to the source file. `entry` selects a public
package export; the package needs the author-owned fields of its
[publication manifest](../ecosystem/manifest/).

Contract paths and package specifiers resolve from the release source file at
build time. Package exports need a Node default resolution, as publication does.
The release records one canonical file URL for both planning and execution;
other URL schemes and file URL queries/fragments are rejected. Contract package
identity and directory-digest provenance remain unchanged.

```yaml title="forecast-release.yml"
- id: forecasts
  name: "@graftland/plugin-remote"
  config:
    package: ./packages/forecasts
    entry: .
    contract: "@example/forecast-contract"
    target: { _tag: Worker }
    config:
      release: unused
      started: unused
      prefix: updated
      credential: !env FORECAST_TOKEN
    probes: [health]
```

Use the exported `build` effect to bootstrap the first release, then install
`plugin({ store, initial, host, socket })` in the host. `host` supplies the
actual Node, Effect and Graft versions, service provenance and placement
capabilities. The default Loader entry accepts the same settings except
`policy`; embedding hosts can pass a transition policy to `plugin`. Trial
defaults to two seconds; other budgets use core defaults. The plugin owns its
integrations, so do not load those entries a second time through Loader.

## Plan and apply

Enable `@graftland/plugin-release/cli` as a command plugin. Every command talks
to the running application's Unix socket; build paths are resolved there.

```sh
graft release build /app/forecast-release.yml --socket /app/control.sock --json
graft release plan TARGET --socket /app/control.sock --json
graft release apply TARGET --expected CURRENT --socket /app/control.sock --json
graft release rollback --expected CURRENT --socket /app/control.sock --json
graft release history --socket /app/control.sock --json
graft release status --socket /app/control.sock --json
```

| Operation           | Rule                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan`              | Verifies bytes, checks service bindings, provenance and runtime requirements, and decodes configuration. Lists code, config, added and removed changes.                                           |
| `apply`             | Checks the expected current id under the release lock. A config-only change transitions the same artifact with new input.                                                                         |
| Failure             | `Aborted` or `Recovered` retains the previous id. Earlier accepted entries are compensated in reverse order using fresh transitions.                                                              |
| Failed compensation | Marks the deployment `Degraded`; further apply requests fail until restart. `RecoveryFailed` and `Stuck` are never reported as successful rollback.                                               |
| Boundaries          | Live additions, removals, contract/placement changes and unmanaged edits are rejected. A new membership needs a separately bootstrapped store and application restart.                            |
| Concurrency         | One process owns a store. Admitted applies belong to the plugin scope, not the requesting connection. Use Releases exclusively for its entries; observed outside transitions invalidate the plan. |

Multi-entry changes are sequential, not atomically visible as a group. The last
accepted id remains visible alongside `Applying` or `Degraded`. Exit code zero
means the command succeeded; rejection, unsuccessful transition outcomes and
transport failures exit nonzero. `--json` emits a structured reply.

Planning imports release their resources before returning. Active contract
imports remain owned by the release plugin and close with it.

The control client has a ten-minute deadline covering connection, response
headers and body. Timeout or interruption closes its socket, including when a
connected server never sends headers.

## Journal and revocations

Before starting units, recovery validates the accepted bootstrap and completed
transactions against current/previous ids and accumulated revocations. A commit
requires an accepted outcome for every changed entry. A schema-valid but
inconsistent journal is rejected; startup never promotes an unfinished intent.

The synced, atomically replaced journal records intent, safe transition outcome
summaries, current/previous ids and startup selection. An interrupted intent is
not resumed: startup creates units from the last accepted release. Corruption
fails closed. Protect the journal and release store together. Raw causes and
decoded input are excluded from disk and control replies; in-process callers
retain complete causes. A corrupt journal is not repaired automatically.

Build carries committed `revocations` forward. `--revoke credential:old` adds a
revocation; `--reference credential:old` declares a reference in use. Applying a
release, including rollback, fails if its references intersect accumulated
revocations. `--override-revocations` explicitly authorizes restoration and is
recorded in the journal; it never removes revocations. Revocations govern
release selection, not external credential issuers.

Restrict the socket directory to the application owner; the socket has mode
`0600`. Keep host gateways outside the release plugin's subtree. Graft handles
transitions within one application. Use existing deployment tooling for fleet
rollout. External steps and points of no return are outside this release layer.
