# Gateway integration

Keep one gateway upstream session while replacing its injected integration unit.

## Run

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Worker Overlap
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Process Restart
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start Runner Restart
```

The command starts a separate kernel process, captures built JavaScript, holds
an old unary call, upgrades to version 2, and reconnects control by Change id.

## Observe

The report shows Accepted, versions 1 and 2, one gateway unit and upstream
session, ExplicitTarget selection, healthy current code, native old exit, zero
remaining Change leases and unconfirmed units, remaining budget and the original
cause.

## Limits

Worker is a fault boundary. This sample does not sandbox untrusted code,
preserve a session after gateway or kernel death, or prove successful finalizers
after forced exit.
