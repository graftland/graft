# Remote runner

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

An invoice exporter runs on a runner over **wss + JWT** and calls the host's
ledger. Restarting the host creates a new exporter only after the old one has
exited. Its larger generation lets the ledger reject delayed writes from the old
exporter.

## Run it

Use Node.js 22.22 or later on Linux or macOS. From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-runner start
devenv shell -- pnpm --filter @graftland/sample-remote-runner test
```

Everything runs on this machine. `src/lab.ts` uses `graft-remote certificates`
for the server certificate, generates an ES256 key and a ten-minute JWT with
`sub: billing`, installs the built package under `.cache/lab/install`, and
starts a runner on 127.0.0.1.

The host loads `graft.yml` twice. It explicitly loads `host/websocket` and
`host/auth/jwt`; `ledger` runs locally and `exporter` runs on the runner. The
saved entry id `exporter` is its instance name. Expect:

```text
Runner listening on port 52341
INV-1 exported by generation 1 (runner child 68017)
… remote.generation: 1, remote.termination: Exited
INV-2 exported by generation 2 (runner child 68072)
A late write from generation 1 was rejected: the ledger has seen 2
… remote.generation: 2, remote.termination: Exited
```

Each stop waits for confirmed process exit. The second host uses the same
instance, so generation advances. The ledger rejects a deliberately delayed
generation-1 write with `StaleGeneration`. The test verifies both calls, exits,
and fencing. Each demo run recreates `.cache/lab`; a real deployment preserves
its state directory so generations keep increasing.

`src/contract.ts` defines `Ledger` and `Exporter`. `src/worker.ts` is the runner
implementation; `src/exporter.ts` reads host settings on activation.
`src/host.ts` runs the restart story. `src/credentials.ts` signs demo tokens;
`src/issue-token.ts` exposes that helper as a standalone script.

Generation checks belong in the external system. They reject stale writes; they
do not undo accepted writes or make calls exactly once.

## Use a real runner machine

From this sample directory after building, generate the demo token and server
certificate:

```sh
CREDENTIALS_DIR=.cache/credentials node dist/issue-token.js
pnpm exec graft-remote certificates --out certs --server runner.example
```

The script writes `jwt-public.pem` and `token`, and does not save the private
signing key. Tokens expire in ten minutes. Rerunning generates a new key:
replace the runner's public key and restart it too. This is a demonstration, not
an issuer service; for deployment, use your issuer's token and public key or
JWKS URL. JWT expiry does not close an already authenticated session. Stolen
tokens can be replayed while valid, so use wss and short lifetimes.

Copy `server.crt`/`server.key` and `jwt-public.pem` to the runner. Keep `ca.crt`
and `token` on the host; keep `ca.key` with the operator. No client TLS
certificate is used. Existing CA files are reused by `certificates`; `--force`
replaces requested leaf certificates.

Install `@graftland/remote` and this built package with dependencies under
`/srv/graft/install`, with its own `package.json`. These are workspace packages;
no registry release is assumed. Run under an external supervisor that stops the
whole process group, and preserve `/var/lib/graft`:

```sh
graft-remote serve --listen wss://0.0.0.0:7443 --auth jwt \
  --cert server.crt --key server.key \
  --jwt-issuer https://issuer.example --jwt-audience graft \
  --jwt-algorithm ES256 --jwt-public-key jwt-public.pem \
  --root /srv/graft/install --state /var/lib/graft
```

On the host, from this directory:

```sh
RUNNER_HOST=runner.example RUNNER_PORT=7443 RUNNER_SERVERNAME=runner.example \
RUNNER_CA=certs/ca.crt RUNNER_TOKEN="$(cat .cache/credentials/token)" \
LEDGER_FILE=ledger.json pnpm exec graft start
```

Press Ctrl+C and wait for `remote.termination: Exited`. Start again with the
same YAML and the generation increases. This manual mode only loads the
exporter; add a host plugin injecting `Exporter` to make calls.

## Connect over SSH

Instead of wss/JWT, load `@graftland/remote/host/command` in the host YAML in
place of `host/websocket` and `host/auth/jwt`. Use:

```ts
Remote.runner({
	transport: Remote.command([
		"ssh",
		"-T",
		"graft@runner.example",
		"graft-remote",
		"serve",
		"--stdio",
		"--identity",
		"billing",
		"--root",
		"/srv/graft/install",
		"--state",
		"/var/lib/graft-ssh",
	]),
	// The loader entry id supplies instance; do not add auth.
})
```

For a key restricted to this runner command, put the following on one line in
the remote account's `~/.ssh/authorized_keys`, replacing the public-key
placeholder and executable path:

```text
restrict,command="/srv/graft/install/node_modules/.bin/graft-remote serve --stdio --identity billing --root /srv/graft/install --state /var/lib/graft-ssh" ssh-ed25519 AAAA... billing-host
```

SSH authenticates the caller; the forced command fixes the runner identity. Do
not allocate a TTY or print banners to stdout: it carries protocol bytes, while
logs go to stderr. Stdio serves one session per process and holds the state lock
until execution units have exited. Concurrent invocations cannot share that
directory; sequential ones retain increasing generations. SSH exit alone does
not confirm remote termination. This SSH recipe is documentation only; the
automated sample tests wss/JWT.

See the [remote guide](https://graftland.github.io/graft/remote/) for leases,
three stopping outcomes, configuration files, and the trust boundaries.
