---
title: Captured artifacts
description: Capture and verify a built implementation before launching it.
---

An **artifact** is a captured package directory and a versioned SHA-256
identity. Its identity includes the selected implementation module, directory
entries, file names and file bytes. Capture does not import the implementation.

## Capture built code

```ts
import { Effect } from "effect"

import { Artifact } from "@graftland/plugin-remote"

export const capture = Effect.gen(function* () {
	const artifact = yield* Artifact.capture({
		directory: "./built-integration",
		module: "dist/index.js",
		store: "./artifacts",
	})
	yield* Artifact.verify(artifact)
	const implementation = yield* Artifact.implementation(artifact)
	return { artifact, implementation }
})
```

| Operation                 | Result                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Artifact.capture`        | Copies a built package into a content-addressed directory and returns its location and identity.         |
| `Artifact.verify`         | Rehashes the captured copy and returns its identity, or fails with `ArtifactError`.                      |
| `Artifact.implementation` | Verifies the copy and returns the captured module's file URL for the `implementation` deployment option. |

All three operations require explicit execution. Importing `Artifact` performs
no filesystem work. A captured copy is independent of subsequent source edits. A
detected source change during capture aborts it. Identical captures reuse the
same directory; a corrupted existing copy is rejected instead of overwritten.

## Supported directories

| Requirement  | Rule                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package      | A directory containing `package.json` and a built `.js`, `.mjs` or `.cjs` module.                                                                                                                                      |
| Module       | A normalized relative path inside the directory.                                                                                                                                                                       |
| Files        | Regular files and directories only. Symlinks on captured paths, including escaping links, are rejected. Sockets, devices and other special files are unsupported.                                                      |
| Store        | Outside the captured closure, including after resolving filesystem aliases. A store inside an explicitly excluded directory is allowed.                                                                                |
| Exclusions   | Normalized package-relative paths. The selected module and package.json must remain captured; excluded paths are not traversed.                                                                                        |
| Dependencies | Files inside the directory are captured, including real `node_modules` directories. Imports outside it are not captured or pinned. Bundle implementation dependencies or keep the external runtime installation fixed. |
| Trust        | This is content identity, not a sandbox. The store and runtime installation must be controlled by the operator.                                                                                                        |

External runtime dependencies are not captured or pinned. They remain part of
the operator-managed runtime installation.

Do not modify captured directories. Verification detects changed content; it
does not repair it. Workspace layouts with symlinked dependencies must be built
into a supported package directory first. Code shipping, dependency installation
and automatic transitions are not provided by this API.

Loader descriptors mark declared external runtime dependencies as uncaptured.
Their observed versions and locations do not pin their bytes. The inventory
covers declarations; undeclared dynamic imports remain outside that inventory.
