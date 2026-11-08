import { createServer, type Socket } from "node:net"

import {
	Array,
	Cause,
	Deferred,
	Effect,
	Fiber,
	FiberSet,
	FileSystem,
	HashSet,
	Layer,
	Option,
	Path,
	Schema,
	Stream,
} from "effect"
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
	barrierPort?: number,
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
	yield* fs.writeFileString(
		path.join(contractDirectory, "nested.js"),
		`import * as Contract from ${remote};import {Config,Service,Alt} from "./shared.js";export default Contract.make({name:"nested",config:Config,inject:[Alt],provides:[Service]});`,
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
		`import {createConnection} from "node:net"; import {Effect,Option} from "effect"; import {Headers} from "effect/http"; import * as Plugin from ${plugin}; import * as Graft from ${graft}; import {Weather,WeatherAlt,ProviderOnly,Boundary,Rejected,CallerOnly,Config,Service,Alt} from ${shared};
 export default Plugin.make({name:"provider",config:Config,overlap:true,provides:[Service,Alt,ProviderOnly,Boundary],apply:(config)=>Effect.gen(function*(){const value={read:(at,fail)=>Effect.gen(function*(){const local=yield* ProviderOnly;if(local.value!=="provider")return yield* Effect.die("Handler lost provider services");const source=yield* CallerOnly;if(source!=="provider")return yield* Effect.die("Caller context crossed the unit boundary");const term=yield* Plugin.term;if(term!==(config.mode==="alt"?1:config.mode==="upgrade"?3:2))return yield* Effect.die("Handler lost provider authority");yield* Effect.scope;${barrierPort === undefined ? "" : `if(config.mode==="scope"&&fail===false)yield* Effect.addFinalizer(()=>Effect.callback(resume=>{const socket=createConnection({host:"127.0.0.1",port:${barrierPort}},()=>socket.write("closing\\n"));socket.once("data",()=>resume(Effect.void));socket.once("error",cause=>resume(Effect.die(cause)));return Effect.sync(()=>socket.destroy());}));`}if(fail===true)return yield* Rejected.make({at});return at;})};yield* Graft.provide(Boundary,(effect,request)=>Option.isSome(Headers.get(request.headers,"x-privileged"))?Effect.die("Caller privileges crossed the unit boundary"):effect);yield* Graft.provide(ProviderOnly,{value:"provider"});yield* Graft.provide(Weather,value);yield* Graft.provide(WeatherAlt,value);})});`,
	)
	yield* fs.writeFileString(
		path.join(consumerDirectory, "plugin.js"),
		`import {Effect,Schema} from "effect"; import {RpcClient} from "effect/rpc"; import * as Plugin from ${plugin}; import {Weather,WeatherAlt,ProviderOnly,Rejected,CallerOnly,Config} from ${shared};
 export default Plugin.make({name:"consumer",config:Config,inject:[Weather${two ? ",WeatherAlt" : ""}],apply:()=>Effect.gen(function*(){const weather=yield* Weather;const at=yield* Schema.decodeEffect(Schema.DateFromString)("2026-11-08T00:00:00.000Z");const result=yield* weather.read(at,false).pipe(RpcClient.withHeaders({"x-privileged":"caller","traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"}),Effect.provideService(ProviderOnly,{value:"caller"}),Effect.provideService(CallerOnly,"consumer"));if(!(result instanceof Date)||result.getTime()!==at.getTime())return yield* Effect.die("Success codec did not cross the direct channel");const error=yield* weather.read(at,true).pipe(RpcClient.withHeaders({"x-privileged":"caller","traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"}),Effect.provideService(ProviderOnly,{value:"caller"}),Effect.provideService(CallerOnly,"consumer"),Effect.flip);if(!Schema.is(Rejected)(error)||Object.getPrototypeOf(error)!==Rejected.prototype||!(error.at instanceof Date)||error.at.getTime()!==at.getTime())return yield* Effect.die("Typed error codec did not cross the direct channel");${two ? "const alt=yield* WeatherAlt;yield* alt.read(at,false);" : ""}})});`,
	)
	yield* fs.writeFileString(
		path.join(providerDirectory, "nested.js"),
		`import {Effect} from "effect";import * as Plugin from ${plugin};import * as Graft from ${graft};import {Config,Weather,WeatherAlt,Service,Boundary} from ${shared};export default Plugin.make({name:"nested",config:Config,inject:[WeatherAlt],provides:[Service,Boundary],apply:()=>Effect.gen(function*(){const alt=yield* WeatherAlt;yield* Graft.provide(Boundary,effect=>effect);yield* Graft.provide(Weather,{read:(at,fail)=>alt.read(at,fail)});})});`,
	)
	return {
		nested: yield* Artifact.capture({
			directory: providerDirectory,
			entry: "nested.js",
			store: path.join(directory, "nested"),
		}),
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

const cleanupBarrier = Effect.fnUntraced(function* () {
	const closing = yield* Deferred.make<Socket>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const server = yield* Effect.acquireRelease(
		Effect.sync(() =>
			createServer((socket) =>
				socket.once("data", () => run(Deferred.succeed(closing, socket))),
			),
		),
		(server) =>
			Effect.sync(() => {
				server.close()
			}),
	)
	yield* Effect.callback<void>((resume) => {
		server.once("error", (cause) => resume(Effect.die(cause)))
		server.listen({ host: "127.0.0.1", port: 0 }, () => resume(Effect.void))
	})
	const address = yield* Effect.sync(() => server.address())
	if (address === null || typeof address === "string")
		return yield* Effect.die("Expected cleanup barrier address")
	return {
		port: address.port,
		closing: Deferred.await(closing),
		release: Effect.gen(function* () {
			const done = yield* Deferred.isDone(closing)
			if (!done) return
			const socket = yield* Deferred.await(closing)
			yield* Effect.sync(() => socket.write("release\n"))
		}),
	}
})
it.live(
	"retains a received native result through blocked owned cleanup and drains it before old-unit exit (I5, I8, I9)",
	() =>
		Effect.gen(function* () {
			const barrier = yield* cleanupBarrier()
			const f = yield* fixture(false, false, barrier.port)
			const provider = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "scope" },
				placement: "Worker",
			})
			const consumer = Units.target({
				artifact: f.consumer,
				contractArtifact: f.contractArtifact,
				contract: "consumer.js",
				input: { mode: "test" },
				placement: "Process",
			})
			const layer = Kernel.layer({
				authority: "owned-cleanup",
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
				for (const instance of ["provider", "provider", "consumer"]) {
					const outcome = yield* Change.run({
						instance,
						target: instance === "consumer" ? consumer : provider,
						strategy: "Restart",
						budget,
					})
					assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				}
				yield* barrier.closing
				const kernel = yield* Kernel.Kernel
				const before = yield* kernel.calls
				const held = Array.findFirst(before, (c) => c.credit).pipe(
					Option.getOrThrow,
				)
				assert.equal(held.result, "Received")
				const watching = yield* kernel.changes.pipe(
					Stream.filter((s) => s.phase === "Draining"),
					Stream.runHead,
					Effect.forkScoped,
				)
				const target = Units.target({
					artifact: f.provider,
					contractArtifact: f.contractArtifact,
					contract: "provider.js",
					input: { mode: "upgrade" },
					placement: "Worker",
				})
				const change = yield* Change.submit({
					instance: "provider",
					target,
					strategy: "Overlap",
					budget: { ...budget, total: 60000, drain: 10000 },
				})
				const draining = yield* Fiber.join(watching)
				assert.equal(Option.getOrThrow(draining).id, change.id)
				const status = yield* kernel
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.equal(HashSet.size(status.outstandingCalls), 1)
				yield* barrier.release
				const outcome = yield* change.await
				assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				const after = yield* kernel
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.equal(HashSet.size(after.outstandingCalls), 0)
				assert.equal(HashSet.size(after.unconfirmedUnits), 0)
				const units = yield* kernel.units
				assert.equal(
					Array.findFirst(units, (u) => u.id === held.provider).pipe(
						Option.getOrThrow,
					).evidence,
					"Exited",
				)
			}).pipe(Effect.provide(layer), Effect.ensuring(barrier.release))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)

it.live(
	"rejects nested cross-unit completion before dispatching the second hop (I9, I12)",
	() =>
		Effect.gen(function* () {
			const f = yield* fixture()
			const target = (
				artifact: Artifact.Artifact,
				contract: string,
				mode: string,
			) =>
				Units.target({
					artifact,
					contractArtifact: f.contractArtifact,
					contract,
					input: { mode },
					placement: "Worker",
				})
			const b = target(f.provider, "provider-alt.js", "alt")
			const a = target(f.nested, "nested.js", "nested")
			const consumer = target(f.consumer, "consumer.js", "test")
			const layer = Kernel.layer({
				authority: "nested",
				maxUnits: 4,
				instances: [
					{ id: "b", target: b },
					{ id: "a", target: a },
					{ id: "consumer", target: consumer },
				],
				bindings: [
					{ consumer: "a", provider: "b", service: "fixture/WeatherAlt" },
					{ consumer: "consumer", provider: "a", service: "fixture/Weather" },
				],
			}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
			yield* Effect.gen(function* () {
				for (const [instance, target] of [
					["b", b],
					["a", a],
				] satisfies ReadonlyArray<readonly [string, Kernel.Target]>) {
					const outcome = yield* Change.run({
						instance,
						target,
						strategy: "Restart",
						budget,
					})
					assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				}
				const outcome = yield* Change.run({
					instance: "consumer",
					target: consumer,
					strategy: "Restart",
					budget,
				})
				assert.equal(outcome.outcome, "RecoveryFailed")
				assert.include(Cause.pretty(outcome.cause), "NestedCompletion")
				const kernel = yield* Kernel.Kernel
				const calls = yield* kernel.calls
				assert.isFalse(
					Array.some(calls, (c) => c.service === "fixture/WeatherAlt"),
				)
			}).pipe(Effect.provide(layer))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)

it.live(
	"retains runner call credit and Stuck evidence after control disconnect without native exit (I5, I9, I10)",
	() =>
		Effect.gen(function* () {
			const barrier = yield* cleanupBarrier()
			const f = yield* fixture(false, false, barrier.port)
			const runner = yield* Units.serveRunner({
				socket: f.directory + "/loss.sock",
				owner: "runner-call-loss",
			})
			const provider = Units.target({
				artifact: f.provider,
				contractArtifact: f.contractArtifact,
				contract: "provider.js",
				input: { mode: "scope" },
				placement: "Runner",
				runner: runner.address,
			})
			const consumer = Units.target({
				artifact: f.consumer,
				contractArtifact: f.contractArtifact,
				contract: "consumer.js",
				input: { mode: "test" },
				placement: "Worker",
			})
			const layer = Kernel.layer({
				authority: "runner-call-loss",
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
				for (const instance of ["provider", "provider", "consumer"]) {
					const outcome = yield* Change.run({
						instance,
						target: instance === "consumer" ? consumer : provider,
						strategy: "Restart",
						budget,
					})
					assert.equal(outcome.outcome, "Accepted", Cause.pretty(outcome.cause))
				}
				yield* barrier.closing
				const kernel = yield* Kernel.Kernel
				const watcher = yield* kernel.changes.pipe(
					Stream.filter((s) => s.phase === "Draining"),
					Stream.runHead,
					Effect.forkScoped,
				)
				const change = yield* Change.submit({
					instance: "provider",
					target: provider,
					strategy: "Restart",
					budget: { ...budget, drain: 300, stop: 300, terminate: 300 },
				})
				yield* Fiber.join(watcher)
				yield* runner.disconnect
				const result = yield* change.await
				assert.equal(result.outcome, "Stuck", Cause.pretty(result.cause))
				const status = yield* kernel
					.get(change.id)
					.pipe(Effect.flatMap(Effect.fromOption))
				assert.equal(HashSet.size(status.outstandingCalls), 1)
				assert.equal(HashSet.size(status.unconfirmedUnits), 1)
				const calls = yield* kernel.calls
				assert.isTrue(
					Array.some(calls, (c) => c.credit && c.result === "Received"),
				)
				const units = yield* kernel.units
				assert.equal(
					Array.findFirst(units, (u) => u.id === "provider@2").pipe(
						Option.getOrThrow,
					).evidence,
					"Missing",
				)
				yield* barrier.release
			}).pipe(Effect.provide(layer), Effect.ensuring(barrier.release))
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	45000,
)
