---
title: Compatibility checks
description: Check plugin requirements against a host before loading code.
---

A **compatibility check** compares published manifests with an explicit host
description. It imports no implementation modules and installs nothing. Run it
before loading an installed or unpacked package.

## Describe the host

Save a preflight file such as `graft.check.json`:

```json
{
	"host": {
		"node": "22.22.0",
		"effect": "4.1.2",
		"graft": "0.0.0",
		"placement": "Worker",
		"filesystem": true,
		"nativeModules": false,
		"services": [],
		"operations": []
	},
	"entries": [
		{
			"id": "forecasts",
			"directory": "./node_modules/@acme/forecast",
			"entry": "."
		}
	],
	"catalog": []
}
```

| Field             | Meaning                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `host`            | Actual runtime versions and capabilities of the selected deployment host.                                          |
| `host.services`   | Provided service groups as `{ "key": "service/key", "operations": ["read@1"] }`, matching the actual Context keys. |
| `host.operations` | Contract operation records provided by the host, in the manifest's `operations` format.                            |
| `entries`         | Entries to enable together, each with its instance id, package directory and public entry.                         |
| `catalog`         | Other packages available as suggestions. Listing a package here does not enable it.                                |
| Paths             | Relative to this preflight file, including catalog paths.                                                          |

Entry names use `.` or concrete `./subpath` exports. Configuration rejects bare
names, empty or dot path segments, traversal and wildcard patterns. Missing
entries yield `MissingEntry`; inherited object properties are never entries.

## Run the check

```sh
graft --no-plugins check graft.check.json
```

`--no-plugins` also skips command-plugin discovery. The command exits nonzero
when any diagnostic remains. `Manifest.check` exposes the same pure check to
embedded applications. The file describes a flat deployment, not Loader realm
visibility or dependency startup order. It does not rewrite `graft.yml` or
change `graft add` and `graft start`; run the preflight explicitly in deployment
scripts before those commands.

| Diagnostic           | Action                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MissingEntry`       | Select an exported entry listed in the package's manifest.                                                                                                         |
| `MissingOperation`   | Enable one provider of the named service and its complete operation set. The message identifies the needing entry and suggests matching packages from the catalog. |
| `ProvenanceConflict` | One operation comes from different contract package names or different directory digests. Both sources are named; select one package at one digest.                |
| `Runtime`            | Use Node, Effect and Graft versions satisfying the package's ranges, or select another plugin version.                                                             |
| `Placement`          | Choose a supported placement with the declared filesystem/native-module capabilities.                                                                              |
| `InvalidManifest`    | Regenerate missing operation provenance with `graft remote manifest`.                                                                                              |

One contract package name at one directory digest never conflicts, including
when multiple entries or exports declare the same operation. This is a
provenance check; it does not compare schema definitions.

Each required service must have one provider in the host or another selected
entry, with the same Context key and every required operation identity.
Operations from different services or partial providers cannot be combined to
satisfy it. Optional services do not block startup. A different operation
version never substitutes for the requested version. Package versions are
runtime requirements and provenance; they do not replace operation
compatibility.

A passing check is conditional on truthful metadata and the supplied host
inventory. It does not prove probes, external connectivity, arbitrary business
semantics or safe native code. [Verify the manifest](../manifest/) and run the
[conformance kit](../conformance/) before publishing. Trust and grants remain
operator policy.
