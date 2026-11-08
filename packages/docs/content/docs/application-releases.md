---
title: Application releases
description: Plan, apply, observe and roll back immutable application releases.
---

`@graftland/plugin-release` builds **releases**: immutable directories
containing captured plugin and contract bytes, configuration and publication
metadata. The workflow uses the public [kernel control client](../units/) and
[Changes](../transitions/).

| Operation  | Result                                                                          |
| ---------- | ------------------------------------------------------------------------------- |
| `build`    | A content-addressed release id; no plugin activation                            |
| `load`     | Verified targets with input references resolved for planning                    |
| `plan`     | Pure Change operations and an `Added`, `Changed` or `Removed` reason per member |
| `apply`    | One Change id, its outcome, phase and diagnostic                                |
| `observe`  | Current Change status by id, or `None` if unknown                               |
| `history`  | Applications and outcomes joined with the journal                               |
| `rollback` | A new Change applying the previous accepted release                             |

## Plan and apply

Use one release store and journal per application. Configure a durable
[release recorder](../recording/) for the application instances, and authorize
targets through the control client before applying them.

```ts
import { Effect } from "effect"

import * as Release from "@graftland/plugin-release"
import type * as Control from "@graftland/plugin-remote/Control"

declare const client: Control.Client
declare const current: ReadonlyArray<Release.CurrentInstance>
const store = { releases: "./releases", journal: "./journal" }

const deploy = Effect.gen(function* () {
	const id = yield* Release.build(store.releases, {
		file: "./release.yml",
		references: [],
		revocations: [],
	})
	const release = yield* Release.load(store.releases, id)
	const preview = Release.plan(release, current)
	const result = yield* Release.apply(client, store, id, current)
	const status = yield* Release.observe(client, result.change)
	const releases = yield* Release.history(store)
	return { preview, result, status, releases }
})
```

| Rule              | Behavior                                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current instances | Supply all instances owned by this release workflow, with their current targets. Omit infrastructure such as the recorder. Instances absent from the release are removed.                                        |
| Comparison        | Code, contract, placement, input or probe changes deploy the member. Relocating identical captured bytes does not.                                                                                               |
| Request identity  | The release id determines the apply key. The first plan and options are retained; a repeated completed apply returns the original result, including failures. Build a new release to request another deployment. |
| References        | `load` and a new application resolve environment references. Stored plans contain member names and reasons, not resolved configuration values.                                                                   |
| Empty plan        | `apply` fails with `ReleaseError` code `NoChanges` when no earlier application exists and the supplied current targets already match.                                                                            |
| Placement         | `Worker` uses a Worker; `Local` uses a Process unit. Custom commands and Worker arguments are rejected.                                                                                                          |
| Older artifacts   | Releases without captured contracts must be rebuilt for this workflow. `metadataOnly` skips publication inspection during build; applying still verifies publication metadata.                                   |

Keep the store at a stable location. Captured packages may still import external
runtime dependencies; see [package publication](../publishing/).

## Observe and inspect history

`observe` returns the public Change status, including member facts and its
conclusion. `apply` reports failed outcomes without converting them to success;
check each member before treating a failed application as unchanged.

| History field              | Meaning                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `release`, `change`, `run` | Release id, Change id and optional kernel run identity          |
| `outcome`                  | Recorded or saved conclusion; `None` while unknown              |
| `recorded`                 | The journal contains a conclusion for this exact run and Change |
| `diagnostic`               | The retained journal diagnostic, or empty when unavailable      |

`history` works without a running kernel and verifies the referenced release
bytes. Keep the release store's application receipts with its journal. A result
saved only by the applying client has `recorded: false`; durable kernel recovery
requires the recorder. Repeated results read diagnostics from the journal;
receipts do not keep a second copy. Cancelling a wait does not cancel an
admitted Change.

## Roll back

Call `rollback(client, store, current)` with the current application targets. It
selects the distinct accepted release before the latest accepted application;
failed applications do not become rollback targets. With fewer than two distinct
accepted releases, it fails with `ReleaseError` code `NoPreviousRelease`.

Rollback resolves references again and submits a fresh Change through normal
admission. It does not modify policy or reuse the target release's old apply
result. A revoked target remains rejected with `Unauthorized`; release
`revocations` metadata cannot grant permissions. The returned outcome describes
the rollback attempt, including any failure or recovery.
