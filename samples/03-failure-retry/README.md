# 03 · Failure and retry

English

A layer can fail to build. Graft keeps the failure and, when asked, tries again
on a schedule.

You will learn:

- A failed build puts the mount in `Failed` and keeps the complete cause.
- `retry` builds the mount again after each failure, using a `Schedule`. Each
  attempt that fails shows up in `mount.state` as `Failed` with its cause.
- Waiting for `Active` in `mount.state` is how the sample gets past the
  failures; `mount.await` is for a mount that settles for good.

All the sample logic is in [`src/program.ts`](src/program.ts);
[`src/main.ts`](src/main.ts) runs it.

## Run it

From the repository root:

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland-samples/03-failure-retry start
```

```text
Connecting (attempt 1)
The backend is not ready yet
Connecting (attempt 2)
The backend is not ready yet
Connecting (attempt 3)
The mount is active
Using the backend, ready: true
Closing the backend
```

The graph also logs each `Failed` attempt with its `NotReady` cause. Those lines
are omitted here.

## Try it

- Remove `retry`. The mount stays `Failed`, and `mount.await` fails with
  `NotReady`.
- Give the mount a bounded schedule, such as `Schedule.recurs(1)`. It fails
  twice and then waits for a change instead of trying forever.
