# Slice 3: immutable application releases

Ship `@graftland/plugin-release` as an ordinary public-API plugin. It owns a
fixed set of named, managed Worker or child-process integrations. The host and
its persistent gateway session remain outside that set. `Releases` exposes
`build`, `plan`, `apply`, `observe`, `rollback`, and `history`; the CLI reaches
the same service over a local Unix socket. Fleet rollout remains the job of
existing deployment tools.

## Versioned boundary

A release is a SHA-256 addressed directory containing captured implementation
packages, normalized `graft.yml`, generated publication manifests, package-based
provenance, and `release.json`. Configuration is encoded input, never decoded
runtime state. `!env NAME` (or `{ "$env": "NAME" }`) stays a reference; values
are resolved only in memory. Authors must keep secrets out of package files and
literal configuration. No environment snapshot, business data, external runtime
dependencies, schema document, or schema fingerprint is captured. The store must
remain in the application's dependency-resolution tree.

## Plan and apply

Build accepts a managed-only release source using Loader entry ids. Each entry
names a package directory/public export, contract module, direct placement,
encoded configuration, and probes. It captures the package before deriving its
manifest. Plan verifies release bytes, checks slice 2 service/provenance/runtime
compatibility, resolves references, and decodes each contract's config. It lists
code, config, added, and removed changes. Live membership, contract, placement,
and unmanaged changes are rejected explicitly in this slice.

Apply serializes release operations and checks the expected current id under
that lock. Every changed entry uses `Graft.transition`, including config-only
changes. Only all-`Accepted` results advance current/previous ids. On failure,
earlier accepted entries transition back in reverse order. Failed compensation
marks the deployment degraded and blocks further applies until restart; it never
claims atomic multi-entry visibility. Caller cancellation does not own an
admitted apply. Core remains the sole execution state machine.

## Durability and revocation

An atomically replaced, synced journal records intent before work, sanitized
outcomes after each transition, and accepted current/previous ids. Startup
selects the last fully accepted release, records that selection, and starts its
managed entries. Incomplete intents are not resumed. Journal/control responses
omit arbitrary causes and decoded inputs; full transition causes remain in the
in-memory result. Storage failures fail closed. One process owns a store.

Release manifests list capability/credential references in use and explicit
`revocations`. Build carries committed revocations forward. Apply and rollback
reject references intersecting the accumulated revocations unless the operator
explicitly overrides; override never erases the revocation record. No external
step, point of no return, credential issuer integration, or fleet orchestrator.

## Proof and delivery

Tests cover immutable capture/tampering, config decode and probe rejection,
expected-id races, compensation, journal restart selection, references without
secret persistence, revocation/override, and the socket boundary. The packed
WebSocket gateway proof exercises good config, invalid config, failed probe,
rollback, and revocation while preserving its session and activations. Add a
release guide and CLI/production updates in English, Simplified Chinese, and
Traditional Chinese. Run `treefmt`, typecheck, tests, build, packed-gateway, and
packed-ecosystem through `devenv shell --`.
