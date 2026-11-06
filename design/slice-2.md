# Slice 2: publication and compatibility

## Plan

Ship a small publication workflow that an independent author can run against
built packages, without workspace aliases or privileged first-party access.

1. **Manifest.** Version the `graft` field in `package.json`. Each public entry
   names its built implementation, contract modules, declared probes and
   placement requirements. Generate required, optional and implemented operation
   identities from `inject`, `provides` and contract descriptors. Derive runtime
   ranges from `engines.node` and Effect/Graft peer dependencies. Verification
   rejects drift and missing declarations; schemas remain executable Effect
   values.
2. **Provenance.** Record package name/version, the existing versioned Artifact
   directory identity, and each operation's contract package name/version and
   Artifact directory digest. Inspect built package directories explicitly;
   imports perform no I/O. External runtime dependencies are not captured or
   pinned.
3. **Compatibility.** A public pure checker and `graft check` compare an
   explicit host description with selected package entries before loading. Check
   exact operation inclusion within the same service binding, conflicting
   package provenance, runtime ranges and placement capabilities. Report the
   needing entry, missing identity and providers from an explicit candidate
   catalog. Optional dependencies do not block startup.
4. **Conformance.** A public Remote test kit checks manifest/code agreement,
   portable RPC value round trips, cancellation with observed cleanup, declared
   business/infrastructure failures, and declared probes. Authors supply domain
   examples and synchronization hooks; the kit owns checks and deadlines. Use
   the same kit for first-party and third-party fixtures.
5. **Publication proof.** Pack two separate author fixtures and a first-party
   fixture into an isolated consumer, compile with installed public
   declarations, run conformance on Worker and child-process placements, and
   reject an incompatible fixture with an actionable diagnostic. Reuse
   packed-gateway's release staging. Add negative tests so broken checks cannot
   silently pass.
6. **Documentation and validation.** Add manifest, compatibility and conformance
   guides and update CLI/packaging pages in all three languages. Run treefmt,
   typecheck, tests, build, packed-gateway and the packed ecosystem proof.

## Settled decisions

- Follow Koishi's required/optional/implements vocabulary, using `name@version`
  operation identities bound to their Context service keys. Each required group
  needs one provider with the same key and every required operation; operation
  unions across different services or partial providers do not satisfy it.
- Keep portable manifest data and compatibility in core; Remote owns package
  inspection and conformance. No second lifecycle engine.
- `graft check` is metadata-only. `graft remote manifest` is an author command
  registered by `remote/cli`; it explicitly imports built code but never runs
  `apply`. Each inspection runs in a disposable worker with a fresh transitive
  module cache; only metadata returns to the caller.
- Runtime ranges come from standard package metadata. Filesystem/native-module
  needs and supported placements are author declarations, not inferred grants.
- Operation provenance is contract package name/version plus the versioned
  Artifact directory digest. No schema is serialized or hashed. Different
  package names or different digests for one operation are provenance conflicts;
  one package name at one digest never conflicts. Diagnostics name both sources.
- Directory identities reuse Artifact's byte traversal but omit the selected
  entry. Different exports of one contract package therefore share provenance;
  execution artifact identities retain their existing entry-sensitive digest.
- Store contracts in a separate package when generating manifests: embedding a
  package's own whole-directory digest in its manifest would change that digest.
- Publication accepts opaque schemas, streaming and middleware. The direct
  conformance harness's unary, self-contained limits belong to the kit alone.
  Its portable codec round trip checks runtime values, not a contract document.
- Provenance is neither compatibility nor trust. No registry, trust field,
  sandbox, automatic installation, adapter selection or migration system.
- Conformance uses today's Remote failure types. It does not invent the target
  architecture's future `ContractFailure` union.

- Compare normalized operation sets element by element, never through delimiter
  encoding. Commas remain valid in operation identities.
- Entry selection uses own properties only, including provenance and catalog
  suggestions. Preflight configuration accepts concrete public export paths.
- Every effectful conformance comparison shares the per-stage deadline; timeout
  diagnostics identify the operation and comparison stage.

- Host bindings and package service groups use the same provenance-completeness
  check. Every host operation needs package name/version and directory digest,
  even without a selected consumer; missing records identify the host service.
- Conformance addresses operations by `(service key, operation identity)` in
  requests, session inventories, declaration agreement, codecs, dispatch and
  coverage. Sharing an operation identity does not share coverage across service
  keys. Session inventory and the suite's declared bindings must agree.
