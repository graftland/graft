import {
	Array,
	Cause,
	Effect,
	FileSystem,
	Layer,
	Path,
	Schedule,
	Schema,
	String,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Units from "../src/Units"
import { budget } from "./unit-binding-fixture"

const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const Received = Schema.fromJsonString(
	Schema.Union([
		Schema.TaggedStruct("Delivered", { seq: Schema.Int, payload: Schema.Int }),
		Schema.TaggedStruct("Lost", { seq: Schema.Int }),
		Schema.TaggedStruct("Dropped", { count: Schema.Int }),
	]),
)
const decodeReceived = Schema.decodeEffect(Received)

const fixture = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = new URL("../.cache/notification-tests/", import.meta.url)
		.pathname
	yield* fs.makeDirectory(root, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
	const [contract, emitter, subscriber] = Array.map(
		["contract", "emitter", "subscriber"],
		(name) => path.join(directory, name),
	)
	const remote = yield* quote(
		new URL("../dist/Contract.js", import.meta.url).href,
	)
	const notifications = yield* quote(
		new URL("../dist/Notifications.js", import.meta.url).href,
	)
	const plugin = yield* quote(
		new URL("../../core/dist/Plugin.js", import.meta.url).href,
	)
	const graft = yield* quote(
		new URL("../../core/dist/Graft.js", import.meta.url).href,
	)
	yield* Effect.forEach(
		[contract!, emitter!, subscriber!],
		(d) =>
			fs
				.makeDirectory(d)
				.pipe(
					Effect.andThen(
						fs.writeFileString(
							path.join(d, "package.json"),
							'{"name":"notification-fixture","version":"1.0.0","type":"module"}',
						),
					),
				),
		{ discard: true },
	)
	yield* fs.writeFileString(
		path.join(contract!, "shared.js"),
		`import {Context,Schema} from "effect"; import * as Notifications from ${notifications};
 export class Ticks extends Context.Service()("fixture/Ticks") {}
 export const Service=Notifications.service(Ticks,"fixture/ticks",Schema.Int);
 export const Empty=Schema.Struct({});
 export const Output=Schema.Struct({file:Schema.String});`,
	)
	yield* fs.writeFileString(
		path.join(contract!, "emitter.js"),
		`import * as Contract from ${remote}; import {Empty,Service} from "./shared.js"; export default Contract.make({name:"emitter",config:Empty,provides:[Service]});`,
	)
	yield* fs.writeFileString(
		path.join(contract!, "subscriber.js"),
		`import * as Contract from ${remote}; import {Output,Service} from "./shared.js"; export default Contract.make({name:"subscriber",config:Output,inject:[Service]});`,
	)
	const contractArtifact = yield* Artifact.capture({
		directory: contract!,
		module: "emitter.js",
		store: path.join(directory, "contracts"),
	})
	const shared = yield* quote(
		new URL("shared.js", new URL("file://" + contractArtifact.directory + "/"))
			.href,
	)
	yield* fs.writeFileString(
		path.join(emitter!, "plugin.js"),
		`import {Effect,Ref,Schedule} from "effect"; import * as Plugin from ${plugin}; import * as Graft from ${graft}; import * as Notifications from ${notifications}; import {Ticks,Service,Empty} from ${shared};
 export default Plugin.make({name:"emitter",config:Empty,provides:[Service],apply:()=>Effect.gen(function*(){const {publish,channel}=yield* Notifications.emitter({wait:"200 millis"});yield* Graft.provide(Ticks,channel);const counter=yield* Ref.make(0);yield* Ref.updateAndGet(counter,n=>n+1).pipe(Effect.flatMap(publish),Effect.repeat(Schedule.spaced("20 millis")),Effect.forkScoped);})});`,
	)
	yield* fs.writeFileString(
		path.join(subscriber!, "plugin.js"),
		`import {appendFileSync} from "node:fs"; import {Effect} from "effect"; import * as Plugin from ${plugin}; import * as Notifications from ${notifications}; import {Ticks,Output} from ${shared};
 export default Plugin.make({name:"subscriber",config:Output,inject:[Ticks],apply:(config)=>Effect.gen(function*(){const ticks=yield* Ticks;yield* Notifications.subscribe(ticks,(delivery)=>Effect.sync(()=>appendFileSync(config.file,JSON.stringify(delivery)+"\\n"))).pipe(Effect.forkScoped);})});`,
	)
	return {
		directory,
		contractArtifact,
		emitter: yield* Artifact.capture({
			directory: emitter!,
			module: "plugin.js",
			store: path.join(directory, "emitters"),
		}),
		subscriber: yield* Artifact.capture({
			directory: subscriber!,
			module: "plugin.js",
			store: path.join(directory, "subscribers"),
		}),
	}
})

it.live(
	"delivers notifications between units in order with ordinary unary calls",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const f = yield* fixture()
			const file = f.directory + "/received.jsonl"
			const layer = Kernel.layer({
				authority: "notifications",
				maxUnits: 4,
				instances: [],
				bindings: [
					{
						provider: "emitter",
						consumer: "subscriber",
						service: "fixture/Ticks",
					},
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				const result = yield* Change.run({
					operations: [
						{
							_tag: "Deploy",
							instance: "emitter",
							target: Units.target({
								artifact: f.emitter,
								contractArtifact: f.contractArtifact,
								contract: "emitter.js",
								input: {},
								placement: "Worker",
							}),
						},
						{
							_tag: "Deploy",
							instance: "subscriber",
							target: Units.target({
								artifact: f.subscriber,
								contractArtifact: f.contractArtifact,
								contract: "subscriber.js",
								input: { file },
								placement: "Process",
							}),
						},
					],
					budget,
				})
				assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
				const lines = yield* fs.readFileString(file).pipe(
					Effect.map((text) =>
						Array.filter(String.split(text, "\n"), String.isNonEmpty),
					),
					Effect.orElseSucceed((): ReadonlyArray<string> => []),
					Effect.repeat({
						schedule: Schedule.spaced("50 millis"),
						until: (lines) => lines.length >= 10,
					}),
					Effect.timeout("20 seconds"),
				)
				const deliveries = yield* Effect.forEach(lines, (line) =>
					decodeReceived(line),
				)
				assert.isAtLeast(deliveries.length, 10)
				// Without loss or overflow every delivery arrives, in publication order.
				Array.forEach(deliveries, (d, i) => {
					assert.equal(d._tag, "Delivered")
					if (d._tag === "Delivered") {
						assert.equal(d.payload, d.seq)
						if (i > 0) assert.deepInclude(deliveries[i - 1], { seq: d.seq - 1 })
					}
				})
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	40000,
)
