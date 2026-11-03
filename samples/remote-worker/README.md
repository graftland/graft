# Remote worker

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

The host asks a child process to format `hello`. The child publishes
`Formatter`; the host injects it and receives `Worker: HELLO` with the child's
PID. The host imports the contract, never the worker implementation.

## Run it

Use Node.js 22.22 or later on Linux or macOS. From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-worker start
devenv shell -- pnpm --filter @graftland/sample-remote-worker test
```

The program prints `Worker: HELLO (child ..., host ...)` with two different
PIDs, then closes its scope and waits for the child to exit. No certificates or
network services are needed. The test checks the reply, separate PID, and
confirmed exit. It builds its own child executable so it can run alongside the
package tests.

## Files

| File                         | Purpose                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `src/contract.ts`            | Config, service key, RPC mapping, and implementation location. |
| `src/worker.ts`              | Publishes the formatter in the child.                          |
| `src/host.ts`                | Loads the proxy, injects the service, and makes a call.        |
| `src/main.ts`                | Supplies Node services, runs the host, and prints the result.  |
| `test/remote-worker.test.ts` | Checks the call and cleanup with a real child.                 |

`WorkerUnavailable` keeps connection failures in the service's typed error
channel. Calls are not retried. The child has normal OS permissions; a separate
process is not a security sandbox.

## Run the worker on another machine

Build and install this sample and its runtime dependencies on the runner
machine. Its installation root must contain
`node_modules/@graftland/sample-remote-worker/package.json` and the built `dist`
files. The package exports `@graftland/sample-remote-worker/contract`. Install
`@graftland/remote` there too. These are workspace packages; no registry release
is assumed. Use matching contract versions on the host and runner.

Prepare server and client certificates from a dedicated CA. The server
certificate must match the hostname, and the client needs exactly one SAN URI
such as `graft://demo`. Then run the installed executable:

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert /run/secrets/server.crt --key /run/secrets/server.key \
  --ca /run/secrets/clients-ca.crt --lease "15 seconds" --grace "5 seconds"
```

Wait for `Listening`. Run under an external supervisor that stops the whole
process group or container. Preserve the state directory across restarts and
keep installed packages unchanged while running.

In `src/main.ts`, replace the local `formatInChild(...)` call with:

```ts
formatInChild({
	contractModule: "@graftland/sample-remote-worker/contract",
	target: Remote.runner({
		instance: "formatter-demo",
		host: "runner.example",
		port: 7443,
		tls: { servername: "runner.example", ca, cert, key: Redacted.make(key) },
	}),
})
```

Import `Remote` from `@graftland/remote` and `Redacted` from `effect`. Here
`ca`, `cert`, and `key` are PEM contents read from host files during activation;
replace `runner.example` with the server's hostname. The
[remote plugin guide](https://graftland.github.io/graft/remote/) shows the full
Effect Config entry using environment variables for these paths. Rebuild, then
run `start` again. The PID in the reply now belongs to the runner machine.

This direct host call supplies `instance`. A `graft.yml` entry can omit it and
use the saved entry id instead. Replacing a network instance waits for
old-process exit and increases its generation. See the guide for leases,
stopping outcomes, and the limits of that guarantee. The sample test only runs
the local target.
