---
title: Hot reload
description: Cooperatively replace modules in an embedded application.
---

Hot reload belongs to directly embedded development tooling. `graft start`
rejects `--watch`; rebuild and restart it after edits. Embedded HMR provides no
kernel isolation or termination-based reclamation.

Use the [HMR API](../hmr-api/) to register module leases and drive reloads.

## What happens on a save

After a watcher detects changed observed bytes, HMR imports candidates and
validates their exports. One [`Graft.replace`](../replace/) operation replaces
affected plugins. Independent plugins keep running.

### If a candidate fails

Import or validation failure keeps the old plugins. Failed activation can
produce `RolledBack` or `RecoveryFailed`; retain the complete cause. A managed
fork returns `Skipped / managed-fork`.

### Forced reload

Call `hmr.reload` to force fresh imports of registered entries and tracked
dependencies.

## What triggers a reload

Pass the watched paths and filter to `hmr.watch`. YAML and environment refresh
belong to the embedded application, which explicitly calls Loader APIs.

## When a reload does not apply

Restart for CommonJS/native loading capabilities or a changed local symlink
target. Ambiguous exports and replacement identity conflicts return `Skipped`;
resolve the conflict before retrying.

## Rules for plugin modules

Import modules without I/O. Acquire resources in scoped plugin effects. Keep
Effect and Graft shared, and use ECMAScript modules for code that must reload.

## Limits

A hung import can block embedded reload and shutdown. Node retains versioned ESM
instances, so memory has no hard bound. HMR does not supervise processes.

## Change detection

Native events request content checks. Polling checks metadata and local
resolutions each second; an idle content audit runs at least every ten seconds.
Identical bytes do not trigger replacement. Watch failures retain their complete
causes.

## Leases and observation

A scoped importer owns a lease. Closing the last lease removes that entry from
later reloads and polling. Failed imports retain observations until that lease
closes or a retry replaces them. See
[scoped importers](../hmr-api/#scoped-importers).
