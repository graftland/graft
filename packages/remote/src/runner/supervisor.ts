import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"
import { Supervisor } from "../Supervisor"
import { Directory, PositiveDuration } from "../internal/config"
import * as Lock from "../internal/runner/Lock"
import * as Stores from "../internal/runner/Store"
import * as Execution from "../internal/runner/Execution"
import * as Engine from "../internal/runner/Supervisor"
import { accept } from "../internal/runner/accept"

export const Config = Schema.Struct({
	root: Schema.String,
	state: Schema.String,
	lease: Schema.optionalKey(PositiveDuration),
	grace: Schema.optionalKey(PositiveDuration),
})
export default Plugin.make({
	name: "remote-supervisor",
	config: Config,
	inject: [
		FileSystem.FileSystem,
		Path.Path,
		ChildProcessSpawner.ChildProcessSpawner,
		SecureRandom.SecureRandom,
		Digest.Digest,
	],
	apply: Effect.fnUntraced(function* (options) {
		const path = yield* Path.Path
		const directory = yield* Directory
		const state = path.resolve(directory, options.state)
		yield* Lock.acquire(state)
		const services = yield* Layer.build(
			Engine.layer(options).pipe(
				Layer.provideMerge(
					Layer.merge(
						Stores.layerDirectory(state),
						Execution.layer(path.resolve(directory, options.root)),
					),
				),
			),
		)
		const engine = Context.get(services, Engine.Supervisor)
		const execution = Context.get(services, Execution.Channels)
		yield* Plugin.fork(engine.await)
		yield* Graft.provide(Supervisor, {
			accept: (channel) => accept(engine, execution, channel),
		})
	}),
})
