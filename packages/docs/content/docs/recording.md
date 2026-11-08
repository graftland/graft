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

## Run a recorder

`@graftland/plugin-release/Recorder` is an ordinary recorder: it stores each
record in its unit's memory, then acknowledges it. Deploy it as `instance` with
`{ recorder: "release" }`. A third-party plugin can hold the role through the
same `Recording.Recorder` service; there is no first-party path.

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

| Rule            | Behavior                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Identity        | The unit's control channel names the incarnation. A plugin cannot register or acknowledge for another. |
| Registration    | Accepted from a unit that hosts `instance`; the grant counts once that unit is current.                |
| Acknowledgement | Send it after storing. A repeat is ignored; other content, owner or incarnation is rejected.           |
| Reconnect       | Registering again from the same incarnation replays its outstanding records.                           |
| Durability      | None. Records live in the recorder's memory and in the kernel until acknowledged.                      |

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
