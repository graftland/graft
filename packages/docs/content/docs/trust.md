---
title: Trust and isolation
description:
  Approve immutable integrations and confine untrusted execution with operator
  policy.
---

**Trust policy** belongs to the operator. Package manifests never assign trust.
The release plugin's optional `trust` path selects a JSON policy file, relative
to the application configuration. It governs managed entries in that
application.

- Every governed artifact needs an exact approval before facade admission.
- Untrusted entries require a sandboxed child process; a Worker is not a
  security boundary.
- Host credentials stay in host capability handlers.

## Assign entries

Use the package name and the captured [Artifact digest](../remote/artifacts/).
Replace the example digest with the captured value. First-party packages use the
same assignment and approval checks.

```json title="trust.json"
{
	"version": "1",
	"entries": [
		{
			"entry": "forecasts",
			"artifact": {
				"package": "@example/forecasts",
				"digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			},
			"tier": "untrusted",
			"contractEntry": "dist/index.js",
			"grants": [
				{
					"_tag": "Http",
					"id": "weather",
					"origin": "https://weather.example",
					"credential": "WEATHER_KEY"
				},
				{ "_tag": "Files", "id": "data", "directory": "/srv/forecast-data" }
			]
		}
	]
}
```

| Field                  | Meaning                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `version`              | Operator policy version; changing it invalidates existing approvals.                           |
| `entry` and `artifact` | Entry id plus package name and directory digest. Unknown artifacts fail closed.                |
| `tier`                 | `own`, `trusted` or `untrusted`. All require approval; only `untrusted` mandates OS isolation. |
| `contractEntry`        | For untrusted code, the bundled contract export inside the artifact.                           |
| `grants`               | Named host capabilities; changing them requires approval. Filesystem roots are absolute.       |

Install policy before managed entries or projections are used. Policy is
immutable for one runtime; restart after editing it. List each intended artifact
identity, including upgrade candidates. Host code, CLI extensions, launchers and
the host's contract modules are trusted application code, outside plugin
confinement. Do not import an untrusted package into those roles. Ordinary
Remote and runner deployments are rejected while policy is installed.

`@graftland/plugin-remote/Policy` owns tier, grant and revocation rules.
`Policy.install` returns the scoped policy service. Supply it with
`Effect.provideService(Policy.Service, authority)` around the application that
creates managed entries; keep its installation scope alive. The release plugin
supplies this context to its children. Consumers declare
`inject: [Policy.Service]`; `Policy.service` reads the injected context and
fails with a recoverable `PolicyError` if absent. Ordinary plugins may also
publish it with `Graft.provide`. Managed drivers require stable ambient
services: replacing a live graph provider would bypass their coordinator. An
installed admission authority rejects execution without its policy service.
Core's `Trust.register`, `Trust.check` and `Trust.publish` provide atomic
admission and opaque comparison for any policy plugin; there is no separate
service directory. Policy owns copies of decoded operator data and compares them
structurally. Projection plugins validate their own tagged approval payloads;
these describe external views, not contract schemas or identities. Each
allocated attempt owns a separate binding lease, including attempts that fail or
never start. A service key is reusable after all its owners retire.

## Approve a statement

Enable both command plugins, `@graftland/plugin-release/cli` and
`@graftland/plugin-release/approve-cli`, with `cli: true`. Save the chosen
statement from the `approvals` reply as `statement.json`, review it, then
approve that exact file. The local control socket is restricted to its owner;
`who` is an operator-supplied audit label, not a separate authentication system.

```sh
graft release approvals --socket /app/control.sock --json
graft approve statement.json --who operator@example --socket /app/control.sock --json
graft release revoke weather --who operator@example --socket /app/control.sock --json
```

| Approval covers | Comparison                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Artifact        | Package name and captured directory digest, including dependencies present in that directory.                                                                                  |
| Exposed views   | Exact projection tag, logical view name, service/operation binding and payload. MCP includes name, title, description, all four hints and output handling. Whitespace matters. |
| Grants          | Exact capability ids, destinations, filesystem roots and credential reference names.                                                                                           |
| Policy          | Exact version and entry assignment.                                                                                                                                            |

The journal records who, when and the complete statement before enabling calls.
A stale statement returns `Unapproved`. Published presentation facts persist
independently of mounted views. Withdrawing or remounting an unchanged view does
not change approval or block unrelated host consumers. Description publication
changes the approval statement before notifying MCP clients.
`tools/list_changed` never approves a tool: clients with cached lists also
receive `Unapproved` at admission. Approved code bytes do not guarantee
deterministic behavior or freeze the behavior of an allowed external service.

Each fact is keyed by projection tag, stable logical view name, and
service/operation. `Projection.offer("forecast-tools", bindings)` uses the name
chosen by the projection author or operator; use distinct names for separate
server views. A mount UUID is not a logical identity. Each view has one live
owner per Graft runtime; another claim fails with `ProjectionConflict`.

An update replaces only that view's complete fact set. Its latest payloads
survive withdrawal and remount, while revisions do not enlarge the statement.
Reverting to an approved payload restores admission when the rest of the
statement still matches and no revocation blocks it. Updating one view cannot
replace another view of the same operation.

Release-owned policy writes revisions to the release audit journal before
changing admission or exposing metadata. Journal replay restores the latest
facts, including unapproved changes, without restoring obsolete revisions to the
statement. A failed audit write rejects publication. Embedded hosts can supply
`Policy.Audit` for durable history. Embedded recovery passes the latest
publication snapshots to `Policy.install`; approval records alone do not
describe the current views.

Revoking a grant or `env:NAME` reference blocks admission first, then waits up
to five seconds for each affected unit's termination and independently observed
exit, with at most four retirements in parallel. `Policy.termination` defines
these shared limits for revocation, late owners and policy closure. Launcher
preparation propagates pure cancellation without an error log; it logs mixed
cleanup causes completely. Failure reports that exit remains unconfirmed; it
does not reopen admission. Revocations survive restart. Rollback checks grant
references too. Restoration needs the recorded `--override-revocations` and a
matching approval with that explicit override; neither removes the revocation
record. A restarted unit can initialize under that recorded override. Startup
restores the latest audited presentation facts; publishing different metadata
blocks admission again. Carrying a revocation forward does not revoke an
override again; a new explicit revocation does.

## Run untrusted code

The release plugin selects the Linux bubblewrap launcher unless the trusted host
supplies `Sandbox.Current`. Embedded hosts can build `Sandbox.linux` and pass
its `Sandbox.Launcher` through that reference. Custom launchers are trusted code
and must provide equivalent confinement. Missing launchers, unsupported
platforms and namespace failures never fall back to ordinary execution.

| Linux boundary | Scope                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Namespaces     | Mandatory user, mount, PID, IPC, UTS and network namespaces; capabilities dropped; further user namespaces disabled.                  |
| Visible files  | Read-only captured code, a bundled trusted child bootstrap and Node runtime libraries; no host data mounts.                           |
| Environment    | Cleared; governed Worker and ordinary child placements also receive no inherited environment.                                         |
| Network        | No external network interface. Use the HTTP broker.                                                                                   |
| Limits         | 128 MiB Node heap, 256 file descriptors, 16 MiB file-size limit and a 16 MiB temporary filesystem. No hard total-memory or CPU quota. |

Linux needs `bwrap`, `prlimit`, `ldd` and enabled unprivileged user namespaces.
The project CI environment supplies the commands. Real OS tests skip with a
reason where these facilities are unavailable; approval and fake-launcher tests
run everywhere. macOS and other unsupported platforms reject untrusted
execution. Node's `--permission` and scoped read allowances are defense in depth
only:
[Node explicitly does not treat them as a security boundary](https://nodejs.org/api/permissions.html).

Bundle the implementation, its contract export and runtime dependencies into
self-contained JavaScript in the captured package. External runtime dependencies
are not captured or pinned and are not mounted into the sandbox. Use
`build(..., { file, references, revocations, metadataOnly: true })` when
bootstrapping an untrusted release. Governed release builds and plans read
stored publication metadata; they do not import untrusted implementations in the
host, including when building the same release again. Reusing an existing
release verifies its immutable bytes and stored metadata only. Runtime readiness
checks still compare the unit's declarations. Run author publication and
conformance tooling only on code you trust or inside separate isolation.

## Broker capabilities

Declare `Capabilities.service` in the Remote contract's `inject`, and inject
`Capabilities.Broker` in the implementation plugin. Other managed Remote host
injections remain unsupported. Include the broker service and its package
provenance in the release host compatibility metadata. The broker rechecks
approval for every request. Initialize a new integration without broker calls;
its first approval is available after it registers services and exposes its tool
metadata. Probes that need a capability require an existing matching approval.

| Capability              | Rule                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `http({ grant, url })`  | GET only; exact allowed origin, no URL credentials and no redirects. The host adds `Authorization` from the named environment reference. |
| `read({ grant, path })` | Read-only UTF-8 file beneath the named root; canonical paths cannot escape it.                                                           |
| Bounds                  | Five seconds per request; HTTP response and file size limited to one MiB.                                                                |
| Denials                 | `Unapproved`, `Revoked`, `DestinationDenied`, `FileDenied`, `ResponseLimit` or `Unavailable`.                                            |

Choose credential destinations you trust, including their responses. The unit
receives neither credential configuration nor inherited host environment values.
Governed release inputs reject `!env`/`$env` resolution; put credential
reference names in grants. Keep secret literals out of inputs and package files.

## Installation and limits

`graft add` disables dependency lifecycle scripts for every package, including
untrusted packages; recovery installs keep them disabled. Install scripts
execute before a runtime sandbox exists. Packages needing build scripts must be
built in a separate trusted build environment before capture. CLI extensions
execute in the host and must be trusted independently.

This boundary addresses malicious plugin packages reading ungranted files or
secrets, bypassing egress grants, making calls under stale descriptions, and
continuing after revocation. Kernel or sandbox escapes, side channels, a
malicious host or operator, Graft/Effect supply-chain compromise, Windows and
denial of service beyond the listed limits are outside this slice.
