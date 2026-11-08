---
title: Trust policy
description: Declare artifact trust and capability grants.
---

A **trust policy** associates an artifact identity with its allowed
capabilities. Approval belongs to the exact statement; changing artifact bytes
changes that statement.

## Install policy

Install policy in the embedded owner that uses it. Keep its scope alive. Policy
data does not import a plugin or establish a kernel execution boundary.

```ts
import { Effect } from "effect"

import * as Policy from "@graftland/plugin-remote/Policy"

declare const policy: Policy.Policy
export const install = Effect.gen(function* () {
	const authority = yield* Policy.install(policy)
	return yield* authority.statements
})
```

## Execution boundaries

Worker and Process placement isolate execution, not permissions. To run code you
do not trust, sandbox its Process unit:

```ts
import * as Artifact from "@graftland/plugin-remote/Artifact"
import * as Units from "@graftland/plugin-remote/Units"

declare const artifact: Artifact.Artifact
export const target = Units.target({
	artifact,
	contract: "plugin.js",
	input: {},
	placement: "Process",
	confinement: "Sandbox",
})
```

| Rule            | Behavior                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confinement     | Linux bubblewrap: new user, pid, network, IPC and UTS namespaces, no capabilities, a cleared environment, read-only access to the captured artifacts only, Node's permission model, memory, file and size limits. |
| Fail closed     | Without Linux, `bwrap` or `prlimit`, the unit never starts unconfined; preparation fails with `SandboxUnavailable`. Inspection runs sandboxed too.                                                                |
| Placement       | Only `Process`. A sandboxed `Worker` or `Runner` target is rejected with `UnsupportedTarget`.                                                                                                                     |
| Identity        | The sandbox is part of the target identity: approving the sandboxed target does not approve the same code unconfined.                                                                                             |
| Operator policy | `setPolicy({ instance, sandbox: true, values })` makes the kernel admit only sandboxed targets for that instance, including recovery and supervisor restarts.                                                     |
| Self-contained  | Only the captured artifact directories exist inside the sandbox. Bundle the plugin with its dependencies, Effect and Graft included.                                                                              |
| CI              | The Linux suite runs with `GRAFT_REQUIRE_SANDBOX=true`, so it fails instead of skipping when namespaces are unavailable.                                                                                          |

Keep control capabilities and artifact storage trusted. Kernel or sandbox
escapes and side channels are out of scope. Native exit establishes ended
execution, not successful finalizers.
