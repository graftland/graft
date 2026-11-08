---
title: Plugin conformance
description: Check publication metadata, codecs and domain examples.
---

The **conformance kit** checks author-supplied protocol examples. It provides
metadata and codec checks and a domain session runner.

## Run the kit

| Check                   | Evidence                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Conformance.agreement` | Verifies the installed built package against its manifest.                                                                                        |
| `Conformance.roundTrip` | Checks portable JSON encoding and schema equivalence, including non-JSON values.                                                                  |
| `Conformance.run`       | Checks examples, declared probes and cancellation using the supplied session; every implemented service/operation pair needs a case or handshake. |

```ts
import { Schema } from "effect"

import { Conformance } from "@graftland/plugin-remote"

export const portableValue = Conformance.roundTrip(Schema.BigInt, 123n)
```

## Supply domain examples

Every request names its Context service key and exact operation identity. The
session supplies calls, codec comparisons, probes and independently observed
termination. Two services with the same operation identity remain distinct.
Failures preserve their causes. A finite per-stage deadline defaults to five
seconds.

## Prove cancellation

Supply a long-running request, a handshake proving handler start, and a
handshake proving owned cleanup completion. The runner interrupts the request
and checks cleanup before termination. A result alone is not cleanup evidence.
After termination, a subsequent call must fail with RpcClientError.
