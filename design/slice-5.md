# Slice 5: operator trust and bounded isolation

## Scope and decisions

Trust belongs to the operator, never a package manifest. An optional operator
policy file governs every managed entry in its release application, assigning
`own`, `trusted` or `untrusted` by entry, package name and captured Artifact
digest. First-party packages use the same checks. Local host code and contract
declarations loaded into the host remain part of the trusted application.

Approval records contain the immutable artifact identity, exact
projection-tagged presentation payloads, grants, policy version, operator
identity and timestamp. Keep them in the release journal. A changed statement
requires another approval; notification delivery is not approval. Admission
checks the selected generation and approval in the same transaction that counts
the call. MCP publication invalidates the statement before exposing changed
metadata, including for clients with cached lists. Stable publication facts
survive view withdrawal and unchanged remounting; replay restores approved facts
before views mount. Per-attempt binding leases begin at allocation and close on
failed allocation or confirmed retirement. Overlapping attempts have separate
leases; service keys become reusable when all previous owners retire. No schema
hashing or contract-document representation is introduced.

## Isolation and capabilities

Untrusted entries require a child process and a public sandbox-launcher service.
The Linux implementation uses bubblewrap with mandatory user, mount, PID and
network isolation, a cleared environment, dropped capabilities, read-only code,
and explicit brokered filesystem grants. Missing or unusable launchers fail
closed. Node permissions add a second restriction layer; Node does not regard
them as a security boundary. The launcher bounds writable temporary storage and
applies the supported process limits; this is not general denial-of-service
protection.

Use a bundled trusted child bootstrap and self-contained captured plugin code.
Dependencies included in the artifact are covered by its digest; external
runtime dependencies remain uncaptured and unpinned and are not made available
to untrusted implementations. Package inspection must not import untrusted
implementations in the host, including repeated builds of an existing release.
Existing destinations receive byte/metadata verification only. Operators supply
trusted host contract declarations; the sandbox evaluates its own declarations
and core checks them before serving.

The host brokers an explicit HTTP capability over the existing contract channel.
Requests select an allowed origin; credentials are resolved and applied only on
the host. Redirects cannot forward credentials to another destination.
Filesystem grants broker bounded reads beneath named directories; no host data
directory is mounted into the unit. Raw host environment and credentials never
enter the unit. New integrations must initialize without broker calls so their
services and tool metadata can be reviewed before their first approval. Remote
policy owns one termination limit: five seconds per unit and four concurrent
retirements, shared by revocation, late registration and policy closure.
Launcher preparation propagates pure cancellation without an error log; mixed
cleanup causes are logged in full while cancellation keeps precedence.
Revocation closes admission before bounded unit termination, remains durable,
and follows the existing audited rollback override rule. Install untrusted
packages with lifecycle scripts disabled, before runtime isolation can provide
any protection.

## Delivery and proof

1. Keep only atomic admission and opaque immutable comparison in core's public
   `Trust` boundary. Remote's public `Policy.Service` interprets assignments,
   grants, revocations and journal approvals through the same registration API
   available to other plugins. MCP validates and publishes its own tagged
   payloads; core knows neither MCP fields nor Remote tiers and capabilities.
2. Wire Remote child placement, a public launcher, Linux confinement and the
   credential broker. Keep unsupported placements explicit.
3. Integrate durable approvals and revocations with Releases and its local CLI
   control channel; connect MCP view publication to admission invalidation. Keep
   one CLI root per command plugin: `/cli` provides `graft release`, and
   `/approve-cli` provides `graft approve`.
4. Add a malicious fixture and fake-launcher coverage everywhere. Real Linux
   tests assert denied file access, absent host secrets, denied network egress,
   stale approval, revocation and missing-launcher rejection, plus approved
   success. Skip real OS tests with a reason when the launcher is unavailable.
5. Update the trust guide and Remote, MCP, release, CLI and production guides in
   English, Simplified Chinese and Traditional Chinese. Run treefmt, typecheck,
   tests, build and both packed proofs through devenv.

Excluded: Windows, kernel/sandbox escapes, side channels, malicious host or
operator, Graft/Effect supply-chain compromise, fleet orchestration and resource
exhaustion beyond the stated limits. Artifact approval detects code-byte
changes, not arbitrary nondeterministic behavior of unchanged code or changes in
an authorized external service.
