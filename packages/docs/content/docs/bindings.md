---
title: Bindings
description: Connect fixed unit instances through encoded unary contracts.
---

A **binding** selects one provider for a consumer service. Configure fixed
bindings in `Kernel.layer`. Codecs and handlers run inside units; the kernel
receives declaration and route data.

## Declare a binding

```ts
import { Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

import { Kernel } from "@graftland/graft"
import * as Units from "@graftland/plugin-remote/Units"

declare const provider: Kernel.Target
declare const consumer: Kernel.Target
export const runtime = Kernel.layer({
	authority: "weather",
	maxUnits: 4,
	instances: [
		{ id: "forecasts", target: provider },
		{ id: "gateway", target: consumer },
	],
	bindings: [
		{ consumer: "gateway", provider: "forecasts", service: "app/Weather" },
	],
}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
```

## Match contracts

| Rule       | Requirement                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Provider   | One provider covers every required operation. Partial providers are never combined.                                            |
| Identity   | Required immutable `name@version` identities form a subset of the provider declaration.                                        |
| Provenance | Use the same captured `contractArtifact` on both targets. Reusing an identity with another provenance or wire tag is rejected. |
| Shape      | Only unary operations are supported. Duplicate identities and service keys fail Describe.                                      |

## Install a view

A provider upgrade stages the affected routes in every running consumer before
activation. Missing or stale acknowledgements cannot activate the view. A failed
installation discards its staged view; a missing participant exit remains an
unresolved obligation.

Provider handlers use the provider’s Context and Scope. The channel encodes
payloads, typed errors and results. Only `traceparent`, `tracestate` and Graft
origin, capability and ticket metadata cross the boundary. Arbitrary caller
headers and Context services do not cross.
