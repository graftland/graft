import { Effect, Ref, Schema } from "effect"

import { Graft, Plugin } from "@graftland/graft"
import { ModuleResolver } from "@graftland/loader"

import { Config, Http, type Reference } from "../Config"
import traced from "./traced"

const reference = (config: Config): Effect.Effect<Reference> =>
	"exporter" in config
		? Effect.succeed(config.exporter)
		: Schema.encodeEffect(Http)(config).pipe(
				Effect.orDie,
				Effect.map((config) => ({
					name: "@graftland/plugin-otlp/http",
					config,
				})),
			)

const sameConfig = Schema.toEquivalence(Schema.Json)

export default Plugin.make({
	name: "@graftland/plugin-otlp/internal/assembly",
	config: Schema.toType(Config),
	inject: [ModuleResolver.ModuleResolver],
	apply: Effect.fnUntraced(function* (config) {
		const resolver = yield* ModuleResolver.ModuleResolver
		const selected = yield* reference(config)
		const descriptor = yield* resolver.resolve(selected.name)
		const module = yield* Effect.tryPromise({
			try: () => import(descriptor.location),
			catch: (cause) =>
				ModuleResolver.ModuleInvalid.make({ specifier: selected.name, cause }),
		})
		const definition = yield* Effect.fromOption(Plugin.fromModule(module), () =>
			ModuleResolver.ModuleInvalid.make({
				specifier: selected.name,
				cause: "The selected module no longer exports its described plugin",
			}),
		)
		const provider = yield* Graft.plugin(definition, selected.config)
		yield* provider.stable
		const settings = yield* Ref.make(selected.config)
		const consumer = yield* Graft.plugin(traced, config.plugins)
		return Effect.fnUntraced(function* (next: Config) {
			const target = yield* reference(next)
			if (target.name !== selected.name) return false
			const previous = yield* Ref.get(settings)
			if (!sameConfig(previous, target.config)) {
				yield* provider.update(target.config)
				yield* Ref.set(settings, target.config)
			}
			yield* consumer.update(next.plugins)
			return true
		})
	}),
})
