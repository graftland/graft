import {
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
	Scope,
} from "effect"
import { Digest, SecureRandom } from "effect/crypto"
import { ChildProcessSpawner } from "effect/process"

import { Graft, Plugin } from "@graftland/graft"
import { ConfigDirectory } from "@graftland/loader"

import { PositiveDuration } from "../internal/config"
import { accept } from "../internal/runner/accept"
import * as Execution from "../internal/runner/Execution"
import * as Lock from "../internal/runner/Lock"
import * as Stores from "../internal/runner/Store"
import * as Engine from "../internal/runner/Supervisor"
import * as Lifecycle from "../internal/RunnerLifecycle"
import { Supervisor } from "../internal/Supervisor"

export const Config = Schema.Struct({
	root: Schema.String,
	state: Schema.String,
	lease: Schema.optionalKey(PositiveDuration),
	grace: Schema.optionalKey(PositiveDuration),
})
export default Plugin.make({
	name: "@graftland/plugin-remote/runner/supervisor",
	config: Config,
	inject: [
		Plugin.optional(Lifecycle.RunnerLifecycle),
		FileSystem.FileSystem,
		Path.Path,
		ChildProcessSpawner.ChildProcessSpawner,
		SecureRandom.SecureRandom,
		Digest.Digest,
	],
	apply: Effect.fnUntraced(function* (options) {
		const lifecycle = yield* Effect.serviceOption(Lifecycle.RunnerLifecycle)
		const resources = yield* Lifecycle.resources(lifecycle)
		const path = yield* Path.Path
		const directory = yield* ConfigDirectory.pipe(
			Effect.map(Option.getOrElse(() => ".")),
		)
		const state = path.resolve(directory, options.state)
		yield* Lock.acquire(state).pipe(Scope.provide(resources))
		const services = yield* Layer.build(
			Engine.layer(options).pipe(
				Layer.provideMerge(
					Layer.merge(
						Stores.layerDirectory(state),
						Execution.layer(path.resolve(directory, options.root)),
					),
				),
			),
		).pipe(Scope.provide(resources))
		const engine = Context.get(services, Engine.Supervisor)
		const execution = Context.get(services, Execution.Channels)
		yield* Plugin.fork(engine.await)
		yield* Graft.provide(Supervisor, {
			accept: (channel) => accept(engine, execution, channel),
		})
	}),
})
