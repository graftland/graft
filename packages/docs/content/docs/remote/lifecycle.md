---
title: Replacement, leases, and stopping
description: Use this page when planning replacement and shutdown.
---

Use this page when planning replacement and shutdown. It explains what
generations, leases, and exit confirmation guarantee, and how failures reach the
host.

For one authenticated identity and instance, the runner confirms the old process
has exited **before** accepting a replacement. The persisted generation grows,
including after runner recovery. If exit cannot be confirmed, replacement fails.
Read `Remote.Instance` for `{ id, generation }`. External systems can reject
older generations (fencing); they must enforce this themselves. Generations do
not undo writes, make calls exactly once, or coordinate independent runners.
Direct local/worker activations always use generation 1 and fresh ids.

The host renews the lease. Without renewal, the child expires; loss of the
runner also triggers shutdown. Whole-machine suspension pauses enforcement, so
this is not a hard real-time deadline. Process identity checks retain a narrow
PID-reuse window. Keep an external supervisor responsible for descendants.

Stopping first runs graceful Dispose. `shutdownTimeout` defaults to five seconds
and bounds only that step. Afterwards:

- Local children get one more second to exit naturally, then forced termination;
  the spawner escalates to SIGKILL after another second and confirms exit.
- Workers get the same one-second window, then `worker.terminate()` and
  confirmed thread exit. Timeouts remain cleanup errors even after successful
  termination.
- Runner connections wait at most lease plus host `margin`. Runner `grace`
  (default five seconds) is its interruption-to-kill window; `margin` only gives
  the host extra time to obtain confirmation.

| Result                         | Meaning                                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `Exited`                       | Normal stop and process exit confirmed.                                                                                      |
| `Killed`                       | Forced termination confirmed; finalizers may be incomplete.                                                                  |
| `RemoteTerminationUnconfirmed` | Exit unconfirmed, either after disconnection or because the connected runner cannot confirm it. Timeout does not prove exit. |

The first two appear in `remote.termination` logs with instance and generation.
The third is a cleanup error. Clean disconnects produce no ERROR; abnormal
connections produce a Warning with cause and peer identity. Dispose and leases,
not the connection alone, govern execution lifetime. Logs may be dropped under
load; the host reports the count.

The TS proxy exposes declared errors, `Contract.UndeclaredFailure`,
`RemoteWithdrawn`, `RemoteError` (with cause), and `MissingInstance`. Disposal
reports `Fork.CleanupError`; inspect its cause for
`RemoteTerminationUnconfirmed`. Defects remain defects. YAML errors also
identify the entry and failing field.
