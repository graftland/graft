# 04 · Tenants

English

Two tenants run the same layers in one process. Each has its own notes, and each
mount reads its own tenant name. Neither layer takes a tenant ID.

You will learn:

- `isolate` gives a service its own realm below the mount. Two mounts can
  publish the same service key without a `ServiceConflict`.
- A label, as in `[Notes, "acorn"]`, puts every mount using that label into one
  shared realm. A consumer with the same label sees the same service.
- `intercept` adjusts a reference for one mount and everything below it.
  `Graft.intercept(Tenant, ...)` gives each mount its tenant name.
- Unmounting one tenant leaves the others, and their services, alone.

All the sample logic is in [`src/program.ts`](src/program.ts);
[`src/main.ts`](src/main.ts) runs it.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/04-tenants start
```

```text
Opening notes for "acorn"
Opening notes for "northstar"
Saving "launch checklist" for "acorn"
Reading notes
  { texts: [ 'launch checklist' ] }
The reader stopped
Closing notes for "acorn"
Acorn left; Northstar still has its own notes
Saving "launch checklist" for "northstar"
Reading notes
  { texts: [ 'launch checklist' ] }
```

## Try it

- Remove the `isolate` options. Both mounts publish `Notes` in the same realm,
  so the second fails with `ServiceConflict`.
- Change Acorn's label to `"northstar"` without changing its intercept. The
  reader now sees Northstar's notes, because the label selects the realm.
