# Remote runner

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

An invoice exporter writes to a ledger. You want the exporter on another
machine. When the host restarts, an exporter from before the restart must not
keep writing next to the new one. Network delays are another problem: a write
from the old exporter can arrive after the new one has started.

Here the exporter runs on a runner, reached over mutual TLS. The runner starts
the new exporter only after the old one has exited. Each start gets a larger
_generation_. The ledger records the newest generation it has seen and rejects
writes from older ones.

## Run it

Use Node.js 22.22 or later on Linux or macOS, with `openssl` installed. From the
repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-remote-runner start
devenv shell -- pnpm --filter @graftland/sample-remote-runner test
```

Everything runs on this machine. `src/lab.ts` plays the runner machine. It
creates certificates, installs the built packages under `.cache/lab/install`,
and starts `graft-remote serve` on 127.0.0.1. The program prints:

```text
Runner listening on port 52341
INV-1 exported by generation 1 (runner child 68017)
… Remote execution terminated … remote.generation: 1, remote.termination: Exited
INV-2 exported by generation 2 (runner child 68072)
A late write from generation 1 was rejected: the ledger has seen 2
… Remote execution terminated … remote.generation: 2, remote.termination: Exited
```

What happened:

1. A host loads `graft.yml`. The `ledger` entry runs on the host. The `exporter`
   entry starts the worker on the runner, with the entry id `exporter` as its
   instance name. A host plugin calls `Exporter.export("INV-1")`. The worker
   then calls the host's `Ledger` over the same connection, passing its
   generation.
2. The host stops. It waits until the runner confirms that the worker's process
   exited (`remote.termination: Exited`).
3. A second, fresh host loads the same file. The entry id is the same, so it
   asks for the same instance. The runner starts it as generation 2, in a new
   process.
4. The host then sends a write stamped with generation 1, as if it had been
   delayed on the network. The ledger has already seen generation 2 and rejects
   it with `StaleGeneration`.

The ledger keeps its writes in `.cache/lab/ledger.json`. The runner keeps its
generations in `.cache/lab/state`, so they count up for as long as that
directory exists. Each `start` recreates `.cache/lab`, so the program prints the
same generations every time. The test runs the same story with a real runner and
checks the generations, the process exits, and the rejection.

## Files

| File                         | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `graft.yml`                  | The two entries. The exporter's entry id is its instance name.              |
| `src/contract.ts`            | Shared by both sides: config, `Ledger` and `Exporter`, RPCs, errors.        |
| `src/worker.ts`              | Runs on the runner. Injects `Ledger`, provides `Exporter`.                  |
| `src/exporter.ts`            | The entry. Reads the runner's address and certificate paths from env vars.  |
| `src/ledger.ts`              | A host plugin that stands in for an external system and checks generations. |
| `src/host.ts`                | Loads `graft.yml` in a fresh host runtime twice and tells the story.        |
| `src/lab.ts`                 | Plays the runner machine: certificates, installation, `graft-remote serve`. |
| `scripts/certificates.sh`    | Creates a dedicated CA plus runner and host certificates with `openssl`.    |
| `test/remote-runner.test.ts` | Runs the story against a real runner.                                       |

The runner promises that the old process has exited before the new one starts.
Generations are for what that promise cannot cover: writes already in flight,
and systems outside Graft. Those systems must check generations themselves, as
`src/ledger.ts` does. A generation does not undo a write that was accepted
earlier, and does not make calls happen exactly once.

## Use a real runner machine

Create certificates for the runner's hostname. The host's identity becomes
`graft://billing`:

```sh
sh scripts/certificates.sh certs runner.example billing
```

Copy `ca.crt`, `server.crt`, and `server.key` to the runner. Keep `ca.crt`,
`client.crt`, and `client.key` on the host. Keep `ca.key` on neither: it can
sign new certificates.

On the runner, make an installation root with its own `package.json`. Install
`@graftland/remote` and this built package there, with their dependencies, so
that `node_modules/@graftland/sample-remote-runner/package.json` exists. These
are workspace packages; no registry release is assumed. Then start the runner
under a supervisor that stops its whole process group, and keep its state
directory across restarts:

```sh
graft-remote serve --host 0.0.0.0 --port 7443 \
  --root /srv/graft/install --state /var/lib/graft \
  --cert server.crt --key server.key --ca ca.crt
```

On the host, from this directory, set the variables that `src/exporter.ts` and
`src/ledger.ts` read and start `graft.yml`:

```sh
RUNNER_HOST=runner.example RUNNER_PORT=7443 RUNNER_SERVERNAME=runner.example \
RUNNER_CA=certs/ca.crt RUNNER_CERT=certs/client.crt RUNNER_KEY=certs/client.key \
LEDGER_FILE=ledger.json pnpm exec graft start
```

The exporter starts on the runner. Press <kbd>Ctrl</kbd>+<kbd>C</kbd>: the host
logs `remote.termination: Exited`. Start it again and the generation in the log
is one higher. Nothing calls the exporter in this mode; add a host plugin that
injects `Exporter` to use it. The
[remote plugin guide](https://graftland.github.io/graft/remote/) covers leases,
stopping outcomes, and what the runner trusts.
