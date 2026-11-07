import process from "node:process"

import { Effect, FileSystem, Schedule, Stream } from "effect"

import { Graft, Plugin } from "@graftland/graft"

import { Instance } from "../../src/index"
import {
	ChildApi,
	ChildLabel,
	config,
	contract,
	HostApi,
} from "./services-contract"

export default Plugin.make({
	name: "service-implementation",
	config,
	provides: contract.provides,
	inject: [HostApi, FileSystem.FileSystem, Instance],
	apply: Effect.fnUntraced(function* ({ directory, fail }) {
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
				value === -998
					? Effect.sync((): never => {
							process.stderr.write("Runner crash diagnostic tail\n")
							process.exit(73)
						})
					: value === -999
						? fs.writeFileString(directory + "/blocked", "ready").pipe(
								Effect.orDie,
								Effect.andThen(
									Effect.sync((): never => {
										while (true) {
											/* Block only this fixture's main thread. */
										}
									}),
								),
							)
						: host.double(value).pipe(
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
		yield* Graft.provide(ChildLabel, {
			read: Effect.succeed("independent endpoint"),
		})
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
