import { Array, Cause, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

import { Change, Kernel } from "@graftland/graft"

import * as Artifact from "../src/Artifact"
import * as Units from "../src/Units"

const budget = {
	total: 30000,
	startup: 5000,
	probe: 1000,
	drain: 1000,
	stop: 1000,
	terminate: 1000,
}
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const fixture = Effect.fnUntraced(function* (
	malformed: boolean = false,
	two: boolean = false,
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = new URL("../.cache/binding-tests/", import.meta.url).pathname
	yield* fs.makeDirectory(root, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
	const contractDirectory = path.join(directory, "contract")
	const providerDirectory = path.join(directory, "provider")
	const consumerDirectory = path.join(directory, "consumer")
	yield* Effect.forEach(
		[contractDirectory, providerDirectory, consumerDirectory],
		(d) => fs.makeDirectory(d),
		{ discard: true },
	)
	const remote = yield* quote(
		new URL("../dist/Contract.js", import.meta.url).href,
	)
	const plugin = yield* quote(
		new URL("../../core/dist/Plugin.js", import.meta.url).href,
	)
	const graft = yield* quote(
		new URL("../../core/dist/Graft.js", import.meta.url).href,
	)
	yield* Effect.forEach(
		[contractDirectory, providerDirectory, consumerDirectory],
		(d) =>
			fs.writeFileString(
				path.join(d, "package.json"),
				'{"name":"binding-fixture","version":"1.0.0","type":"module"}',
			),
		{ discard: true },
	)
	yield* fs.writeFileString(
		path.join(contractDirectory, "shared.js"),
		`import {Context,Effect,Schema} from "effect"; import {Rpc,RpcGroup,RpcMiddleware} from "effect/rpc"; import * as Contract from ${remote};
 export const CallerOnly=Context.Reference("fixture/CallerOnly",{defaultValue:()=>"provider"});
 export class Weather extends Context.Service()("fixture/Weather") {}
 export class WeatherAlt extends Context.Service()("fixture/WeatherAlt") {}
 export class ProviderOnly extends Context.Service()("fixture/ProviderOnly") {}
 export class Boundary extends RpcMiddleware.Service()("fixture/Boundary") {}
 export class Rejected extends Schema.TaggedError()("Rejected",{at:Schema.DateFromString}) {}
 export const Config=Schema.Struct({mode:Schema.String});
 export const Group=RpcGroup.make(Contract.operation("forecast",${malformed ? 0 : 1},Rpc.make("Forecast",{payload:{at:Schema.DateFromString,fail:Schema.Boolean},success:Schema.DateFromString,error:Rejected}))).middleware(Boundary);
 export const Service=Contract.service(Weather,Group,{toHandlers:s=>({Forecast:({at,fail})=>s.read(at,fail)}),fromClient:c=>({read:(at,fail)=>c.Forecast({at,fail})})});
 export const Alt=Contract.service(WeatherAlt,Group,{toHandlers:s=>({Forecast:({at,fail})=>s.read(at,fail)}),fromClient:c=>({read:(at,fail)=>c.Forecast({at,fail})})});`,
	)
	yield* fs.writeFileString(
		path.join(contractDirectory, "provider.js"),
		`import * as Contract from ${remote}; import {Config,Service} from "./shared.js"; export default Contract.make({name:"provider",config:Config,provides:[Service]});`,
	)
	yield* fs.writeFileString(
		path.join(contractDirectory, "consumer.js"),
		`import * as Contract from ${remote}; import {Config,Service,Alt} from "./shared.js"; export default Contract.make({name:"consumer",config:Config,inject:[Service${two ? ",Alt" : ""}]});`,
	)
	yield* fs.writeFileString(
		path.join(contractDirectory, "provider-alt.js"),
		`import * as Contract from ${remote}; import {Config,Alt} from "./shared.js"; export default Contract.make({name:"provider-alt",config:Config,provides:[Alt]});`,
	)
	const contractArtifact = yield* Artifact.capture({
		directory: contractDirectory,
		entry: "provider.js",
		store: path.join(directory, "contracts"),
	})
	const shared = yield* quote(
		new URL("shared.js", new URL("file://" + contractArtifact.directory + "/"))
			.href,
	)
	yield* fs.writeFileString(
		path.join(providerDirectory, "plugin.js"),
		`import {Effect,Option} from "effect"; import {Headers} from "effect/http"; import * as Plugin from ${plugin}; import * as Graft from ${graft}; import {Weather,WeatherAlt,ProviderOnly,Boundary,Rejected,CallerOnly,Config,Service,Alt} from ${shared};
 export default Plugin.make({name:"provider",config:Config,overlap:true,provides:[Service,Alt,ProviderOnly,Boundary],apply:(config)=>Effect.gen(function*(){const value={read:(at,fail)=>Effect.gen(function*(){const local=yield* ProviderOnly;if(local.value!=="provider")return yield* Effect.die("Handler lost provider services");const source=yield* CallerOnly;if(source!=="provider")return yield* Effect.die("Caller context crossed the unit boundary");const term=yield* Plugin.term;if(term!==(config.mode==="alt"?1:config.mode==="upgrade"?3:2))return yield* Effect.die("Handler lost provider authority");yield* Effect.scope;if(fail===true)return yield* Rejected.make({at});return at;})};yield* Graft.provide(Boundary,(effect,request)=>Option.isSome(Headers.get(request.headers,"x-privileged"))?Effect.die("Caller privileges crossed the unit boundary"):effect);yield* Graft.provide(ProviderOnly,{value:"provider"});yield* Graft.provide(Weather,value);yield* Graft.provide(WeatherAlt,value);})});`,
	)
	yield* fs.writeFileString(
		path.join(consumerDirectory, "plugin.js"),
		`import {Effect,Schema} from "effect"; import {RpcClient} from "effect/rpc"; import * as Plugin from ${plugin}; import {Weather,WeatherAlt,ProviderOnly,Rejected,CallerOnly,Config} from ${shared};
 export default Plugin.make({name:"consumer",config:Config,inject:[Weather${two ? ",WeatherAlt" : ""}],apply:()=>Effect.gen(function*(){const weather=yield* Weather;const at=yield* Schema.decodeEffect(Schema.DateFromString)("2026-11-08T00:00:00.000Z");const result=yield* weather.read(at,false).pipe(RpcClient.withHeaders({"x-privileged":"caller","traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"}),Effect.provideService(ProviderOnly,{value:"caller"}),Effect.provideService(CallerOnly,"consumer"));if(!(result instanceof Date)||result.getTime()!==at.getTime())return yield* Effect.die("Success codec did not cross the direct channel");const error=yield* weather.read(at,true).pipe(RpcClient.withHeaders({"x-privileged":"caller","traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"}),Effect.provideService(ProviderOnly,{value:"caller"}),Effect.provideService(CallerOnly,"consumer"),Effect.flip);if(!Schema.is(Rejected)(error)||Object.getPrototypeOf(error)!==Rejected.prototype||!(error.at instanceof Date)||error.at.getTime()!==at.getTime())return yield* Effect.die("Typed error codec did not cross the direct channel");${two ? "const alt=yield* WeatherAlt;yield* alt.read(at,false);" : ""}})});`,
	)
	return {
		contractArtifact,
		provider: yield* Artifact.capture({
			directory: providerDirectory,
			entry: "plugin.js",
			store: path.join(directory, "providers"),
		}),
		consumer: yield* Artifact.capture({
			directory: consumerDirectory,
			entry: "plugin.js",
			store: path.join(directory, "consumers"),
		}),
		directory,
	}
})
for (const placement of ["Worker", "Process", "Runner"] as const)
	it.live(
		`encoded ${placement} dependency calls preserve codecs, typed errors, provider Context and Scope during candidate startup (I4, I8, I12)`,
		() =>
			Effect.gen(function* () {
				const f = yield* fixture()
				const runner =
					placement === "Runner"
						? yield* Units.serveRunner({
								owner: "bindings-runner",
								socket: f.directory + "/runner.sock",
							})
						: undefined
				const provider = Units.target({
					artifact: f.provider,
					contractArtifact: f.contractArtifact,
					contract: "provider.js",
					input: { mode: "test" },
					placement,
					...(runner === undefined ? {} : { runner: runner.address }),
				})
				const consumer = Units.target({
					artifact: f.consumer,
					contractArtifact: f.contractArtifact,
					contract: "consumer.js",
					input: { mode: "test" },
					placement: placement === "Worker" ? "Process" : "Worker",
				})
				const layer = Kernel.layer({
					authority: "bindings-" + placement,
					maxUnits: 4,
					instances: [
						{ id: "provider", target: provider },
						{ id: "consumer", target: consumer },
					],
					bindings: [
						{
							consumer: "consumer",
							provider: "provider",
							service: "fixture/Weather",
						},
					],
				}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
				yield* Effect.gen(function* () {
					const first = yield* Change.run({
						instance: "provider",
						target: provider,
						strategy: "Restart",
						budget,
					})
					assert.equal(first.outcome, "Accepted", Cause.pretty(first.cause))
					const next = yield* Change.run({
						instance: "provider",
						target: provider,
						strategy: "Restart",
						budget,
					})
					assert.equal(next.outcome, "Accepted", Cause.pretty(next.cause))
					const started = yield* Change.run({
						instance: "consumer",
						target: consumer,
						strategy: "Restart",
						budget,
					})
					assert.equal(started.outcome, "Accepted", Cause.pretty(started.cause))
					assert.isTrue(started.member.healthy)
				}).pipe(Effect.provide(layer))
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		45000,
	)

it.live(
	"rejects malformed operation metadata inside Describe before granting execution (I4, I12)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture(true)
			const target = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const layer = Kernel.layer({
				authority: "invalid-declaration",
				maxUnits: 2,
				instances: [{ id: "provider", target }],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				const rejected = yield* Change.submit({
					instance: "provider",
					target,
					budget,
				}).pipe(Effect.flip)
				assert.equal(rejected.reason, "DescriptionFailed")
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				assert.equal(
					Array.filter(units, (u) => u.kind === "Execution").length,
					0,
				)
				const facts = yield* kernel.inspections
				assert.isTrue(Array.every(facts, (p) => p.exitEvidence === "Exited"))
				assert.include(
					Cause.pretty(facts[0]?.cause ?? Cause.empty),
					"InvalidIdentity",
				)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	15000,
)

it.live(
	"installs one changed dependency without replacing another binding in the same consumer (I3, I8)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture(false, true)
			const a = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const b = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider-alt.js",
				input: { mode: "alt" },
				placement: "Worker",
			})
			const c = Units.target({
				artifact: f.consumer,
				contractArtifact: f.contractArtifact,
				contract: "consumer.js",
				input: { mode: "test" },
				placement: "Process",
			})
			const layer = Kernel.layer({
				authority: "partial-binding",
				maxUnits: 5,
				instances: [
					{ id: "a", target: a },
					{ id: "b", target: b },
					{ id: "c", target: c },
				],
				bindings: [
					{ consumer: "c", provider: "a", service: "fixture/Weather" },
					{ consumer: "c", provider: "b", service: "fixture/WeatherAlt" },
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				for (const [instance, target] of [
					["a", a],
					["a", a],
					["b", b],
					["c", c],
				] satisfies ReadonlyArray<readonly [string, Kernel.Target]>) {
					const result = yield* Change.run({
						instance,
						target,
						strategy: "Restart",
						budget,
					})
					assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
				}
				const next = Units.target({
					artifact: f.provider,
					contractArtifact: f.contractArtifact,
					contract: "provider.js",
					input: { mode: "upgrade" },
					placement: "Worker",
				})
				const result = yield* Change.run({
					instance: "a",
					target: next,
					strategy: "Overlap",
					budget,
				})
				assert.equal(result.outcome, "Accepted", Cause.pretty(result.cause))
				const kernel = yield* Kernel.Kernel
				const units = yield* kernel.units
				assert.isTrue(
					Array.some(
						units,
						(u) =>
							u.instance === "c" &&
							u.kind === "Execution" &&
							u.evidence === "Missing",
					),
				)
				assert.isTrue(
					Array.some(
						units,
						(u) =>
							u.instance === "b" &&
							u.kind === "Execution" &&
							u.evidence === "Missing",
					),
				)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)
