---
title: Recording
description:
  Require an acknowledged record before a Change acts, commits and succeeds.
---

A **recorder** is a plugin in an execution unit that holds the deployment's
recording role. When a Change touches an instance in the recording scope, the
kernel sends the recorder one record per stage and waits for its
acknowledgement.

- No lifecycle action runs before the intent is acknowledged.
- No route activates before the commit decision is acknowledged.
- `Accepted` is reported only after the concluding record is acknowledged.
- Stopping, termination and exit observation never wait for the recorder.

## Declare the role

Recording is deployment data. Every Change whose closure contains an instance in
`scope` is recorded; a request cannot opt out.

```ts
import { Layer } from "effect"

import { Kernel } from "@graftland/graft"
import { Units } from "@graftland/plugin-remote"

declare const instances: Kernel.Deployment["instances"]

export const kernel = Kernel.layer({
	authority: "shop",
	maxUnits: 8,
	instances,
	recording: { recorder: "release", instance: "release", scope: ["checkout"] },
}).pipe(Layer.provide(Units.layer))
```

| Field        | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `recorder`   | The role name a plugin registers for.                                           |
| `instance`   | The only instance whose unit may hold the role.                                 |
| `scope`      | Instances whose Changes need recording.                                         |
| `maxRecords` | Bound on outstanding and promised records. Excess work is rejected. Default 64. |

## Start from a config file

Run `graft start --watch` with a recorder entry:

```yaml title="graft.yml"
- id: release
  name: "@graftland/plugin-release/Recorder"
  recording: { role: release }
  config:
    recorder: release
    directory: ./.graft/journal

- id: checkout
  name: ./plugins/checkout.mjs
```

| Setting           | Rule                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recording.role`  | The role this entry holds; match the role its plugin registers. Any plugin implementing the recording protocol can hold it.                                                                                              |
| `recording.scope` | Entry ids whose Changes require recording. Omit it for every other application entry, including nested and disabled entries. An empty list records none.                                                                 |
| Role holder       | Exactly one enabled application entry may declare a role; groups cannot. It starts separately before recorded entries.                                                                                                   |
| Later edits       | The same declaration is accepted again. Changing or removing the role, holder or scope requires restarting the application; watch reports `RecordingConflict`. Adding or removing entries changes the default scope too. |

## Run a recorder

`@graftland/plugin-release/Recorder` is an ordinary recorder. Deploy it as
`instance` with `{ recorder: "release", directory: "./journal" }`: it appends
each record to the journal there and syncs it to disk before acknowledging.
Without `directory`, records stay in its unit's memory. A third-party plugin can
hold the role through the same `Recording.Recorder` service; there is no
first-party path.

```ts
import { Effect, Stream } from "effect"

import { Plugin } from "@graftland/graft"
import { Recording } from "@graftland/plugin-remote"

export default Plugin.make({
	name: "audit-recorder",
	inject: [Recording.Recorder],
	apply: Effect.fn(function* () {
		const recorder = yield* Recording.Recorder
		yield* recorder.records.pipe(
			Stream.runForEach((record) => recorder.acknowledge(record)),
			Effect.forkScoped,
		)
		yield* recorder.register("release")
	}),
})
```

| Rule            | Behavior                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Identity        | The unit's control channel names the incarnation. A plugin cannot register or acknowledge for another.     |
| Registration    | Accepted from a unit that hosts `instance`; the grant counts once that unit is current.                    |
| Acknowledgement | Send it after storing. A repeat is ignored; other content, owner or incarnation is rejected.               |
| Reconnect       | Registering again from the same incarnation replays its outstanding records.                               |
| Durability      | With `directory`, the journal on disk; otherwise none. The kernel keeps a record until it is acknowledged. |

## Read the journal

The journal is append-only segments, one line per record; concurrent Changes
interleave and nothing is rewritten. `Journal.history(directory)` from
`@graftland/plugin-release` reads it without a running kernel and returns one
summary per kernel run and Change id: stages, members, targets, outcome,
`concluded`, and from the latest record each member's desired and actual target,
health and what the attempt did (`NotStarted`, `Started`, `Ready`, `Failed`,
`Stopped`), the phase and the rendered cause.

| Situation                      | Result                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A record is delivered again    | Acknowledged without a second line. The same id with other content is refused.                                                                    |
| Writing or syncing fails       | Not acknowledged; the next append first cuts back any partial line, and is retried every second while the unit runs, so the Change stays blocked. |
| The process stopped mid-write  | A torn final line is removed when the recorder opens the journal; an earlier bad line refuses to open.                                            |
| The process stopped mid-Change | The Change shows an intent without a conclusion: `concluded` is `false`; its member facts show what had run.                                      |
| The kernel restarted           | Change ids start again at `change-1`; the run id keeps the two apart.                                                                             |

## When recording is missing

| Situation                                | Result                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| No live recorder when work is submitted  | Rejected with `RecordingUnavailable` before a Change id exists.                                  |
| Too many outstanding records             | Rejected with `RecordingCapacity`. No duty is evicted.                                           |
| Recorder stops acknowledging or exits    | Forward work waits. The budget still runs out under the usual [outcome rules](../transitions/).  |
| Only the concluding record is missing    | Execution has finished and stays as it is. No outcome is reported; cancellation changes nothing. |
| Recorder exits with outstanding duties   | A new incarnation cannot acknowledge them. `status.recording.blocked` stays `true`.              |
| Change would replace the recorder's unit | Rejected with `SelfReplacement` if the Change needs recording or any duty is outstanding.        |

`status.recording` shows the gate, outstanding records and whether they are
blocked. `kernel.recording` and [`client.recording`](../control/) list every
outstanding record, including those of a recorder that exited. Kernel process
loss loses them.
