---
title: Captured artifacts
description: Capture and verify a built implementation before launching it.
---

An **artifact** is a captured package directory and a versioned SHA-256
identity. Its identity includes the selected implementation entry, directory
entries, file names and file bytes. Capture does not import the implementation.

## Capture built code

```ts
import { Effect } from "effect"

import { Artifact } from "@graftland/plugin-remote"

export const capture = Effect.gen(function* () {
	const artifact = yield* Artifact.capture({
		directory: "./built-integration",
		entry: "dist/index.js",
		store: "./artifacts",
	})
	yield* Artifact.verify(artifact)
	const implementation = yield* Artifact.implementation(artifact)
	return { artifact, implementation }
})
```

| Operation                 | Result                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Artifact.capture`        | Copies a built package into a content-addressed directory and returns its location and identity.        |
| `Artifact.verify`         | Rehashes the captured copy and returns its identity, or fails with `ArtifactError`.                     |
| `Artifact.implementation` | Verifies the copy and returns the captured entry's file URL for the `implementation` deployment option. |

All three operations require explicit execution. Importing `Artifact` performs
no filesystem work. A captured copy is independent of subsequent source edits. A
detected source change during capture aborts it. Identical captures reuse the
same directory; a corrupted existing copy is rejected instead of overwritten.

Verification occurs when its Effect runs. A string passed to `Remote.plugin`
remains an ordinary module location; it does not request capture or future
verification. Run verification again before a later launch.

## Supported directories

| Requirement  | Rule                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package      | A directory containing `package.json` and a built `.js`, `.mjs` or `.cjs` entry.                                                                                                                                       |
| Entry        | A normalized relative path inside the directory.                                                                                                                                                                       |
| Files        | Regular files and directories only. All symlinks, including escaping links, are rejected. Sockets, devices and other special files are unsupported.                                                                    |
| Store        | Outside the source directory, including after resolving filesystem aliases.                                                                                                                                            |
| Dependencies | Files inside the directory are captured, including real `node_modules` directories. Imports outside it are not captured or pinned. Bundle implementation dependencies or keep the external runtime installation fixed. |
| Trust        | This is content identity, not a sandbox. The store and runtime installation must be controlled by the operator.                                                                                                        |

External runtime dependencies are not captured or pinned. They remain part of
the operator-managed runtime installation.

Do not modify captured directories. Verification detects changed content; it
does not repair it. Workspace layouts with symlinked dependencies must be built
into a supported package directory first. Code shipping, dependency installation
and automatic transitions are not provided by this API.
