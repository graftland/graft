# Native unit execution

Use the public Kernel, Units and Control entries for captured native
deployments. Keep the fixed kernel bootstrap separate from contract and
implementation imports.

| Task                                    | Public entry                            |
| --------------------------------------- | --------------------------------------- |
| Capture built bytes                     | Artifact.capture                        |
| Select Worker, Process or Runner        | Units.target                            |
| Compose fixed instances and bindings    | Kernel.layer and Units.layer            |
| Open metadata control                   | Control.serve                           |
| Submit and observe from another process | Control.connect                         |
| Define encoded unary operations         | Contract.service and Contract.operation |

Pass artifact and optional contractArtifact data, a relative contract entry and
JSON input in the target. Describe imports and validates these inside an
inspection unit before admission. Configuration decoding and handlers also run
inside units. A contractArtifact shared by both endpoints establishes binding
provenance.

Each admitted call is pinned to its provider incarnation. Results and owned
cleanup completion are different facts. Cancellation does not release execution
credit; completion or exact provider exit does. Calls are never retried
automatically. Only single-hop unary calls use the owned completion guarantee.

Keep the gateway unit unchanged while replacing its integration provider.
Overlap keeps admitted calls on old code and routes new calls after commit.
Restart pauses only affected bindings; bounded waiters select the generation on
dispatch. Runner requires Restart. A missing native exit remains visible and can
be Stuck.

Disconnecting public control or interrupting handle.await does not cancel
Change. Reconnect, query by id and compare sequence numbers. Explicit
handle.cancel requests cancellation. Keyed requests and unresolved records last
for the runtime lifetime; unkeyed settled history is bounded. There is no
persistent kernel history.
