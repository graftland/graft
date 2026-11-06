---
title: Plugin conformance
description:
  Test a published plugin through the same public kit as first-party plugins.
---

The **conformance kit** in `@graftland/plugin-remote/Conformance` checks a
plugin's declared protocol behavior. First-party and third-party packages use
the same checks; package names confer no exemption.

The encoding check runs values through `Schema.toCodecJson`. It checks runtime
behavior; it does not turn the contract into a document.

## Run the kit

| Check                   | Public call and required evidence                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest/code agreement | `Conformance.agreement(directory)` verifies the installed built package before activation.                                                                                    |
| Placement               | `Conformance.direct(contract, options)` opens one captured Worker or Local unit without publishing services into the application. Run both supported placements.              |
| Portable encoding       | `Conformance.roundTrip(schema, value)` uses Remote's portable JSON codec and the schema's equivalence, including non-JSON values.                                             |
| Protocol behavior       | `Conformance.run(session, suite)` runs supplied domain examples, the entry's declared probes, and cancellation checks. Every implemented operation needs a case or handshake. |
| Ownership               | Run in an Effect scope with the Node services and secure-random layers. Scope cleanup terminates the direct unit.                                                             |

```ts
import { Schema } from "effect"

import { Conformance } from "@graftland/plugin-remote"

export const portableValue = Conformance.roundTrip(Schema.BigInt, 123n)
```

The
[plugin author fixtures](https://github.com/graftland/graft/tree/main/samples/plugin-authors)
show separate contract and implementation packages, manifest generation,
packing, installed-declaration compilation, compatibility and both placements.
They include two separately maintained author fixtures and a first-party
fixture, not evidence of independent human adoption.

## Supply domain examples

| Expected outcome        | Assertion                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Success`               | The returned value matches the schema's equivalence and survives portable round trips.                                   |
| `BusinessError`         | The declared error survives the boundary as a typed failure, not `RpcClientError`; supply a schema-valid expected value. |
| `InfrastructureFailure` | The call fails with `RpcClientError`, separately from business errors.                                                   |
| `Defect`                | The remote defect remains a defect cause, separately from typed failures.                                                |

There is no public `ContractFailure` union today. The kit checks the current
Effect RPC boundary instead of relabeling its failures. Test the failures your
operation can produce. Direct setup has a five-second deadline; a finite
per-stage deadline defaults to five seconds. Failures retain their causes.

## Prove cancellation

Supply three requests: a long-running request, a handshake that waits until its
handler starts, and another that waits for its request finalizer to finish. The
kit interrupts the admitted request and waits for the cleanup handshake. A
response alone is not cleanup evidence. Use separate requests so the cleanup can
be observed while the cancelled request is gone.

After cleanup, the kit terminates the unit, waits for execution exit, and checks
that a subsequent call fails with `RpcClientError`. The session cannot serve
more examples after `Conformance.run` completes.

The direct harness currently supports self-contained unary fixtures without RPC
middleware or injected contract services. Compose required providers inside a
fixture package when testing a plugin with dependencies, and verify the original
plugin's manifest separately. General streaming and middleware conformance are
not implemented. Samples exercise behavior; they cannot prove all possible
inputs, native-module safety or business semantics.
