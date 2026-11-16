---
"@graftland/graft": minor
---

**Breaking:** Graft is now a single library: an Effect-native runtime for
dynamic layers. The plugin framework, loader, HMR, CLI, project generator and
the separate plugin packages are removed, and `@graftland/graft` is the only
published package. It exposes the `.`, `./rpc`, `./node` and `./testing` entry
points.

**Breaking:** The public surface is redefined around three namespaces: `Graft`,
`Mount` and `Release`. `Graft.mount` and `Graft.publish` return handles whose
services are applied asynchronously, so callers await the handle before relying
on the service; `Graft.fork` supervises a background fiber, and `Graft.mounts`
and `Graft.logs` expose the live mounts and logs. `Mount` handles provide
`state`, `await`, `stable`, `restart` and `unmount`, and `Publication` adds
`set`. `./rpc` provides `Remote.service`, `Remote.serve` and `Remote.connect`;
both serve and connect mount through `Graft.mount`, and `retry` reuses
`MountOptions.retry`. `./node` wraps child-process stdio and worker_threads as
protocols, and `./testing` provides an in-memory protocol.

- A build failure together with a cleanup defect is reported as `[Die, Die]`:
  the build failure and the cleanup failure are both kept as defects instead of
  being collapsed into one.
- Unmounting a mount that is still `Loading` does not wrap finalizer failures as
  `ReleaseInterrupted`; a finalizer defect is logged and the original cause is
  preserved.
- `Layer.CurrentMemoMap` is not published.
