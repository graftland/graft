---
title: Plugin manifests
description: Generate publication metadata and record package provenance.
---

A **plugin manifest** is the versioned `graft` field in `package.json`. It
records public entry points, contract operations and runtime requirements. It
contains no trust claims or permission grants.

## Declare an entry

```json
{
	"name": "@acme/forecast",
	"version": "1.0.0",
	"type": "module",
	"exports": { ".": "./dist/index.js" },
	"engines": { "node": ">=22.19.0" },
	"peerDependencies": { "effect": "4.1.*", "@graftland/graft": "0.0.0" },
	"graft": {
		"version": 1,
		"entries": {
			".": {
				"implementation": "dist/index.js",
				"contracts": ["@acme/forecast-contract"],
				"requirements": {
					"placements": ["Worker", "Local"],
					"filesystem": false,
					"nativeModules": false
				},
				"probes": ["health"]
			}
		}
	}
}
```

| Field          | Author's responsibility                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `entries`      | Use public export names: `.` or `./subpath`. The export must resolve to the selected built implementation.                            |
| `contracts`    | Installed contract module specifiers. Each exports `contract` or a default contract; Node default-export resolution must work.        |
| `requirements` | Supported placements and required host capabilities. These declare needs, not grants.                                                 |
| `probes`       | Names registered with `Plugin.probe` during serving.                                                                                  |
| Runtime ranges | `engines.node` and the `effect` and `@graftland/graft` peers are the single source. Publish real semver ranges, not workspace ranges. |

## Generate and verify

Enable the [Remote command plugin](../../cli/#command-plugins), build the
implementation, then run:

```sh
graft remote manifest ./release
graft remote manifest ./release --check
```

Generation imports built declarations but never runs `apply` or probes. Run it
only on code you intend to import. Module authors must keep imports free of I/O.
Verification exits unsuccessfully on manifest/code disagreement.

| Generated field       | Source                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `services.required`   | Required `Plugin.inject` keys, resolved through the contract descriptors.               |
| `services.optional`   | `Plugin.optional` keys.                                                                 |
| `services.implements` | `Plugin.provides`.                                                                      |
| `operations`          | Exact `name@version`, contract package name/version, and its Artifact directory digest. |

An ordinary service without a contract descriptor fails generation rather than
disappearing from the manifest. Private services belong inside a packaged
composition. Publication reads operation identities without inspecting schemas.
Opaque schemas, streaming and middleware do not prevent publication. The
[conformance kit](../conformance/) has its own supported subset.

Use a separate contract package for generated manifests. Embedding a package's
own whole-directory digest in its manifest would change that digest, so
self-references are rejected before writing.

## Record provenance

```sh
graft remote manifest ./release --check --provenance ./provenance.json
```

**Provenance** records package name/version, the resolved package directory's
versioned [Artifact identity](../../remote/artifacts/), and the contract package
identity and directory digest for each operation. The record must be outside the
package directory. `Publication.provenance` also records an already captured
directory without importing its implementation.

Each operation's `artifact` contains `version`, `algorithm` and `digest` from
`Artifact.directoryIdentity(contractDirectory)`. It hashes package bytes without
selecting an entry, so all exports of one package share that identity. Execution
artifacts retain their separate entry-sensitive identity. Neither identity
serializes schemas or proves the meaning of an operation.

External runtime dependencies are not captured or pinned. Provenance is not
compatibility, publisher authentication, trust, or a permission decision. Use
[compatibility checks](../compatibility/) and
[conformance tests](../conformance/) for their separate questions.
