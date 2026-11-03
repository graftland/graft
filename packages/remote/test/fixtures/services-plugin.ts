import { Graft, Plugin } from "@graftland/graft"
import { Effect, FileSystem, Schedule, Stream } from "effect"
import process from "node:process"
import { Instance } from "../../src/index"
import { ChildApi, HostApi, config } from "./services-contract"
export default Plugin.make({
	name: "service-implementation",
	config,
	inject: [HostApi, FileSystem.FileSystem, Instance],
	apply: ({ directory, fail }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const host = yield* HostApi
			const instance = yield* Instance
			yield* fs.writeFileString(`${directory}/pid`, String(process.pid))
			yield* Effect.addFinalizer(() =>
				fs
					.writeFileString(`${directory}/finalized-${process.pid}`, "done")
					.pipe(Effect.orDie),
			)
			const service: ChildApi["Service"] = {
				call: (value) =>
					host.double(value).pipe(
						Effect.map((value) => ({
							value: value + 1,
							pid: process.pid,
							...instance,
						})),
					),
				values: Stream.iterate(0, (n) => n + 1).pipe(
					Stream.ensuring(
						fs
							.writeFileString(`${directory}/stream-ended`, "done")
							.pipe(Effect.orDie),
					),
				),
				hold: fs
					.writeFileString(`${directory}/holding`, "ready")
					.pipe(
						Effect.orDie,
						Effect.andThen(Effect.never),
						Effect.ensuring(
							fs
								.writeFileString(`${directory}/hold-ended`, "done")
								.pipe(Effect.orDie),
						),
					),
			}
			if (yield* fs.exists(`${directory}/delay-export`)) {
				yield* Plugin.fork(
					fs.exists(`${directory}/release-export`).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (value) => value,
						}),
						Effect.andThen(Graft.provide(ChildApi, service).pipe(Effect.orDie)),
					),
				)
				yield* fs.writeFileString(`${directory}/awaiting-export`, "ready")
			} else yield* Graft.provide(ChildApi, service)
			if (yield* fs.exists(`${directory}/fail-apply`)) {
				yield* Effect.sleep("100 millis")
				return yield* Effect.fail("Remote apply failed")
			}
			if (fail)
				yield* Plugin.fork(
					fs.exists(`${directory}/fail`).pipe(
						Effect.repeat({
							schedule: Schedule.spaced("10 millis"),
							until: (value) => value,
						}),
						Effect.andThen(Effect.fail("Remote worker failed")),
					),
				)
		}),
})
