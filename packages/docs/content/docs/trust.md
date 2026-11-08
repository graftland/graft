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

Worker and Process placement isolate execution, not permissions. Run the runner
owner inside an operator-controlled container or VM when a permission boundary
is needed. Keep control capabilities and artifact storage trusted. Native exit
establishes ended execution, not successful finalizers.
