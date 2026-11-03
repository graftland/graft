# @graftland/package-manager

English |
[简体中文](https://github.com/graftland/graft/blob/main/packages/package-manager/README.zh-CN.md)
|
[繁體中文](https://github.com/graftland/graft/blob/main/packages/package-manager/README.zh-TW.md)

Installs dependencies with npm, pnpm, or Yarn, and rolls back on failure.

The minimum supported Node.js version is 22.19. Windows is provided as is.
Process-tree cleanup and rollback on Windows are not verified, and they are not
promised.

```sh
npm install @graftland/package-manager effect
```

`make` detects the project's package manager. Its `install` adds, updates, or
removes dependencies. If the install fails, it restores `package.json` and the
lockfile. `graft add` and `graft remove` use it.

## Installation ownership and recovery

Use one manager per project. The caller must give the manager and its child
processes exclusive write access to the project. This lasts from the start of an
`install` call until it finishes, including recovery.

- Do not edit project files during this time.
- Do not run another installer at the same time.
- Calls are serialized within one manager. Graft does not enforce a lock across
  managers, editors, or processes.

On POSIX, process cleanup covers only the installer's original process group.
Installation scripts and recovery scripts must not create unmanaged writers.
Examples are children in independent process groups, and daemons that keep
writing project files. Graft does not provide OS-level containment. It does not
discover escaped writers. Confirming that the original group has stopped does
not prove that every possible descendant has stopped. Scripts that break this
rule are outside the rollback guarantee.

Managed paths must be regular files, or must be absent. `make` and each
`install` use `lstat` to check the snapshot set. The snapshot set is
`package.json`, lockfiles, and tracked configuration and installation-state
files.

- Symbolic links are rejected, including dangling links. Other file types are
  rejected too.
- The error is `UnsupportedFileTypeError`. It is raised before any transaction
  write and before any installer starts.
- The error shows the `path` and the `fileType`. The link and its target stay
  unchanged.
- A rejection before the transaction begins does not need recovery. It does not
  make the manager unusable.

### Rollback

Rollback runs when installation fails or is interrupted before commit. It needs
confirmation that the original process group has stopped. Then it does these
things:

- It restores the backed-up package files byte for byte. It keeps their recorded
  permission bits and ownership.
- It removes tracked files that were absent before installation.

The tracked files include `package.json`, lockfiles, and the package-manager
configuration and installation-state files that the manager tracks.

Rollback overwrites changes made during installation. It does not detect
conflicts. It does not merge edits.

When the project already had a lockfile for the selected package manager,
recovery also tries to repair `node_modules`. Recovery errors are kept together
with the original failure. Recovery after a process crash is not promised.

### File writes and process cleanup

Accepted file writes have a completion boundary. Cancellation waits for the
native operation to finish. This happens before rollback, before snapshot
cleanup, and before the manager's lock is released. The transaction tracks its
own file writes and the original installer group. Snapshot creation and rollback
writes have the same completion guarantee.

Each installer process and each recovery process has a ten-minute exit wait.
Cancellation or expiry closes its process scope before files are restored.

- The process receives SIGTERM.
- If it has not stopped after five seconds, it receives SIGKILL.
- On POSIX, even a successful kill must be followed by evidence that the
  original process group no longer exists. Checks run every 20 milliseconds,
  with at most 100 additional checks (two seconds of waiting) for short-lived
  zombie groups to be reaped. EPERM is treated as continued presence, never as
  absence.
- If the group remains or a check fails, termination is unconfirmed: the manager
  keeps its snapshot, skips rollback and recovery, and enters
  `RecoveryRequired`.
- Process cleanup failures stay in the returned cause, together with
  installation and recovery failures.
- The exit timeout does not include process cleanup or file restoration. It is
  not a deadline for the whole install-and-recover operation.

The Node adapter may replace the original OS errno with a generic kill failure.
Only after a POSIX group check confirms absence does PackageManager resolve
signal failures carrying ESRCH or the adapter's specific `Unknown` kill error
with cause `Failed to kill child process`. This does not resolve other reasons
in the same Cause: join failures, other kill errors, defects, and interruption
remain failures. If the group still exists, the original Cause is preserved; if
the group check fails, both complete Causes are retained.

## Committed installs and snapshot cleanup

A successful `install` result means the dependency changes are committed.

`result.snapshotCleanupFailure` is an `Option<SnapshotCleanupFailure>`:

- `None` means snapshot deletion succeeded.
- `Some` contains `snapshotDirectory` and the complete cleanup `cause`,
  including defects.

A failure to delete the snapshot after commit does not turn the install into a
failure. It does not trigger rollback. The manager stays usable, and
`recoveryRequired` stays `None`.

What callers should do:

- Inspect this field. Report or record its Cause.
- Retry the deletion of that snapshot directory after the filesystem problem is
  fixed. The directory may be partly removed.
- Do not restore the old snapshot. Do not repeat the install only because
  snapshot deletion failed. Those changes are already committed.
- The kept data may contain credentials, so make sure it is removed in the end.

Failures before commit still fail the operation and run rollback. Any snapshot
cleanup failure is combined with the original failure.

Cancellation can stop a result from being delivered after commit. It is not
proof that the changes were undone. In that case, cleanup failures are kept in
the interrupted Cause.

## When manual recovery is required

Before an install changes project files, it saves a snapshot. The snapshot is in
a private `graft-recovery-*` directory in the OS temporary directory.

- Only a successful install or a complete rollback allows the snapshot to be
  deleted and another install to run.
- A committed install with a failed snapshot deletion is reported as described
  above.
- Process termination and transaction completion are separate conditions.
  Stopping the writer lets rollback begin. It does not prove that rollback
  succeeded.

If any rollback step fails, the manager keeps the snapshot and needs manual
recovery. This includes restoring files before or after recovery, and running
the recovery installer. It applies even when the final file restoration
succeeds, because failed recovery may have left `node_modules` incomplete.

How the manager restores a file:

1. It creates a temporary file in the target directory, exclusively and with
   mode `0600`.
2. It restores the saved uid/gid when the platform reports them. Then it
   restores the permission bits.
3. It syncs and closes the file.
4. It renames the file over the target.

Metadata failures and temporary-file cleanup failures also need manual recovery.
They stay in the Cause. Timestamps, ACLs, and extended attributes are not
recorded.

If process termination cannot be confirmed, no further restoration or recovery
runs. This avoids a conflict with a process that may still be writing.

### The recovery error

The Cause of the failed call keeps the original failure and all rollback and
termination failures. It includes a `RecoveryRequiredError`, which has these
fields:

- `snapshotDirectory` gives the saved location.
- `directory` identifies the project.
- `recoveryCause` keeps the complete original and recovery Cause.
- `operation` is `rollback` for an incomplete rollback with stopped writers. For
  unconfirmed termination, it is `install` or `recover`. In that case,
  `processId` and `terminationCause` give the process details.

After cancellation, callers can also read `manager.recoveryRequired`. It is an
Effect that yields `Option<RecoveryRequiredError>`. Callers do not need to catch
an interrupted call.

The manager rejects all later `install` calls for good, with this typed error.
This includes calls that are already queued and calls with empty change sets.
`readState` stays a read-only diagnostic operation. It may fail while project
files are incomplete.

### Steps to recover manually

1. Identify the failed installer and all of its descendants, and stop them. The
   recorded process ID is for diagnosis only. It does not prove that a later
   process with the same ID belongs to the installation. Do not restore files or
   start another installer until all writers have stopped.
2. Fix the filesystem problem that stopped the restoration, such as file
   permissions. Then restore the files:
   - Open `snapshot.json` in `snapshotDirectory`. Check its project `directory`
     and `agent`.
   - For each `files` entry, copy the bytes from the named `backup` into a
     temporary file beside the project's `name`. Create the temporary file
     privately and exclusively.
   - Restore the recorded `uid` and `gid` when they are not null. Then restore
     `mode`. Do this before you replace the target.
   - These metadata values are JSON integers. `mode` is the numeric permission
     bitmask, not an octal-formatted string.
   - Create parent directories as needed.
   - A null `backup` means that the file was absent. Remove it if it exists now.
3. Repair `node_modules` with the selected package manager. Use the restored
   manifest and lockfile. After that process has stopped, restore the snapshot
   files again if it rewrote them. The snapshot does not contain `node_modules`.
4. Verify the project. Then delete the snapshot and create a new manager with
   `make`. The old manager has no reset operation.

Snapshots can contain credentials from package-manager configuration files. Keep
them private. They survive the closing of the manager and of the Effect scope.
But the OS may clean temporary directories. If manual recovery will be delayed,
copy a kept snapshot to a safe, private place.

This mechanism is not crash recovery. It is not a project lock across processes.
Creating a new manager does not make a still-live installer safe.

## Documentation

- [Command line](https://graftland.github.io/graft/cli/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).

## Package manager declarations

The shared `PackageManagerDeclaration` Schema accepts `npm`, `pnpm`, or `yarn`
followed by an exact SemVer version (at most 256 characters), including optional
prerelease identifiers. It rejects empty suffixes, leading zeros in numeric
version/prerelease components, ranges, tags, URLs, and surrounding whitespace. A
`+` suffix is reserved for a
[Corepack hash](https://github.com/nodejs/corepack#when-authoring-packages):
`sha224`, `sha256`, `sha384`, or `sha512`, followed by a dot and exactly 56, 64,
96, or 128 lowercase hexadecimal characters respectively. Arbitrary SemVer build
metadata is not supported here. Hash validation checks the declaration's syntax;
it does not download or authenticate the package-manager archive.

Both project creation and package-manager detection use this Schema, exported
from `@graftland/package-manager/PackageManagerDeclaration`. Creation preserves
the supplied declaration verbatim. An explicit detection `agent` still overrides
the manifest declaration.
