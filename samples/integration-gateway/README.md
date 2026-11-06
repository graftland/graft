# Integration gateway

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Keep one WebSocket bot session while replacing an independently packaged
forecast integration. The local server models login, heartbeat, a session id and
messages; it needs no bot account.

## Run

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-integration-gateway start
```

```sh
curl -X POST http://127.0.0.1:PORT/message/London
curl -X POST http://127.0.0.1:PORT/upgrade/v2
curl -X POST http://127.0.0.1:PORT/message/London
curl -X POST http://127.0.0.1:PORT/upgrade/broken-probe
```

Replace `PORT` with the printed operator port. The first message returns a v1
forecast. The upgrade returns `Accepted`, and the next message returns v2. The
broken probe returns `Aborted` with its cause and leaves the current version
serving. Press Ctrl+C to stop.

To see recovery, POST `/upgrade/broken-trial` and, while that request waits,
POST `/message/crash` from another terminal. The outcome is `Recovered`; the
previous pinned artifact starts in a fresh unit. The tests deliberately corrupt
that previous artifact to demonstrate `RecoveryFailed`.

The endpoint listens on localhost and accepts only the sample's named releases.
It is a local demonstration, not an authenticated deployment service.

## Packages and ownership

| Part                             | Responsibility                                                           |
| -------------------------------- | ------------------------------------------------------------------------ |
| `contract/`                      | Public service key, RPC operation identity and business input.           |
| `v1/`, `v2/`                     | Independently packed implementations declaring `provides` and `overlap`. |
| `broken-probe/`, `broken-trial/` | Probe rejection and failure during the trial window.                     |
| `src/gateway.ts`                 | Host-owned WebSocket protocol adapter and injected command consumer.     |
| `src/app.ts`                     | Artifact capture, Loader entry `forecasts` and operator endpoint.        |

The launcher packs Graft's built exports into a temporary project outside the
checkout, installs them, compiles and packs the contract and implementations,
then installs those tarballs. It compiles the consumer without source aliases or
private imports. The same installed code runs in Workers and child processes.

Startup creates `config/graft.yml` in that temporary project. Its `forecasts`
entry names `@graftland/plugin-remote`, the installed contract, a relative
captured-artifact directory and a direct placement. The operator calls
`Graft.transition({ target: "forecasts", candidate })`; it does not rewrite the
file. Loader rejects managed-tree edits before persistence.

Artifacts pin package bytes only. External runtime dependencies are not captured
or pinned. The temporary project and its artifacts are removed on exit.

## Verify

```sh
devenv shell -- pnpm --filter @graftland/sample-integration-gateway test
```

Tests run both direct placements and the real `graft start` command. They check:

- One login, the same session id and unchanged gateway and consumer activations.
- New responses and old-unit exit evidence after healthy and repeated upgrades.
- Probe causes, trial recovery and recovery failure while the session persists.
- A slow admitted v1 request finishing on v1 after cutover.
- Rejected Loader edits leaving the file and accepted target unchanged.

The workspace test suite runs the same installed-consumer test.
