/**
 * A host plugin that stands in for an external system. It keeps its writes in
 * a JSON file and fences out generations older than the newest it has seen.
 */
import { Graft, Plugin } from "@graftland/graft"
import {
	Array,
	Config,
	Effect,
	FileSystem,
	Option,
	Record,
	Schema,
	Semaphore,
} from "effect"
import { Ledger, StaleGeneration, Write } from "./contract.ts"

const State = Schema.Struct({
	latest: Schema.Record(Schema.String, Schema.Int),
	writes: Schema.Array(Write),
})
const Json = Schema.fromJsonString(State)

export default Plugin.make({
	name: "ledger",
	inject: [FileSystem.FileSystem],
	apply: () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const file = yield* Config.String("LEDGER_FILE")
			const lock = yield* Semaphore.make(1)
			// A failing disk is not something the exporter can handle, so it is a defect.
			const load = fs.exists(file).pipe(
				Effect.flatMap((exists) =>
					exists
						? fs
								.readFileString(file)
								.pipe(Effect.flatMap(Schema.decodeEffect(Json)))
						: Effect.succeed({ latest: {}, writes: [] }),
				),
				Effect.orDie,
			)
			const save = (state: typeof State.Type) =>
				Schema.encodeEffect(Json)(state).pipe(
					Effect.flatMap((text) => fs.writeFileString(file, text)),
					Effect.orDie,
				)
			yield* Graft.provide(Ledger, {
				append: (write) =>
					Effect.gen(function* () {
						const state = yield* load
						const latest = Option.getOrElse(
							Record.get(state.latest, write.instance),
							() => 0,
						)
						if (write.generation < latest)
							return yield* StaleGeneration.make({
								instance: write.instance,
								generation: write.generation,
								latest,
							})
						yield* save({
							latest: Record.set(
								state.latest,
								write.instance,
								write.generation,
							),
							writes: Array.append(state.writes, write),
						})
					}).pipe(Semaphore.withPermits(lock, 1)),
			})
		}),
})
