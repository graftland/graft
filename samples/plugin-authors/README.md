# Plugin author fixtures

These packages demonstrate publication through public exports. Alice's echo and
Bob's counter have separate contract and implementation packages. A first-party
echo fixture runs the identical kit. The incompatible package needs an absent
operation and a newer Node runtime. The author names identify test fixtures, not
independent human adoption.

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- node scripts/packed-ecosystem.mjs
```

The script packs release copies, installs them in a temporary consumer project,
compiles each author's code against installed declarations, generates and
verifies manifests, and packs and installs the author packages. It runs the
metadata-only CLI check, rejects the incompatible package, then exercises
portable values, business errors, remote defects, probes, cancellation and
transport failure after termination on Worker and Local. All three compatible
packages must pass. No workspace source alias or private import is used. The
temporary project is removed when the script finishes.

`pnpm test` runs this proof too.

Alice's contract includes a custom runtime check. Publication reads its
operation identities without serializing its schemas. The proof checks each
contract package's directory digest, rejects conflicting package provenance
after a byte change, and rejects self-referential manifest digests before
writing.

Edit one author's implementation and contract independently, then rerun the
script. For your own release, keep `engines.node` and peers current, declare
placement needs, and run `graft remote manifest` before packing. Provenance
records package bytes; external runtime dependencies are not captured or pinned.
