import { createServer, type Socket } from "node:net"

import {
	Cause,
	Deferred,
	Effect,
	FiberSet,
	FileSystem,
	HashMap,
	Layer,
	Option,
	Path,
	Ref,
	Schema,
	Scope,
	Stream,
} from "effect"
import { NodeServices } from "@effect/platform-node"

import * as Kernel from "@graftland/graft/Kernel"

import * as Artifact from "../src/Artifact"
import * as Lines from "../src/internal/jsonLines"
import * as Units from "../src/Units"

export { budget } from "./unit-binding-fixture"

const Reply = Schema.Struct({
	id: Schema.String,
	version: Schema.Int,
	term: Schema.Int,
	session: Schema.Int,
})
type Reply = typeof Reply.Type
const decode = Schema.decodeEffect(Schema.fromJsonString(Reply))
const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const listener = Effect.fnUntraced(function* (
	accept: (socket: Socket) => void,
) {
	const ready = yield* Deferred.make<number>()
	const callbacks = yield* FiberSet.make()
	const run = yield* FiberSet.runtime(callbacks)()
	const server = yield* Effect.acquireRelease(
		Effect.sync(() => createServer(accept)),
		(server) =>
			Effect.sync(() => {
				server.close()
			}),
	)
	yield* Effect.sync(() => {
		server.on("error", (error) =>
			run(Deferred.failCause(ready, Cause.die(error))),
		)
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			const address = server.address()
			run(
				address !== null && typeof address !== "string"
					? Deferred.succeed(ready, address.port)
					: Deferred.failCause(ready, Cause.die("No fixture listener address")),
			)
		})
	})
	return yield* Deferred.await(ready)
})
export const gateway = Effect.fnUntraced(function* (
	placement: Kernel.Placement,
) {
	const callbacks = yield* FiberSet.make()
	const owner = yield* Effect.scope
	const run = yield* FiberSet.runtime(callbacks)()
	const socket = yield* Deferred.make<Socket>()
	const session = yield* Deferred.make<number>()
	const pending = yield* Ref.make(
		HashMap.empty<string, Deferred.Deferred<Reply>>(),
	)
	const next = yield* Ref.make(0)
	const upstream = yield* listener((s) =>
		run(
			Effect.gen(function* () {
				yield* Deferred.succeed(socket, s)
				const incoming = yield* Lines.receive(s)
				yield* Stream.runForEach(incoming, (line) =>
					Effect.gen(function* () {
						const value = yield* decode(line)
						if (value.id === "ready") {
							yield* Deferred.succeed(session, value.session)
							return
						}
						const waiters = yield* Ref.get(pending)
						const waiter = HashMap.get(waiters, value.id)
						if (Option.isSome(waiter))
							yield* Deferred.succeed(waiter.value, value)
					}),
				).pipe(
					Effect.catchCause((cause) =>
						Effect.logError("Gateway fixture upstream ended", cause),
					),
				)
			}).pipe(Scope.provide(owner)),
		),
	)
	const heldSocket = yield* Deferred.make<Socket>()
	const held = yield* Deferred.make<void>()
	const gate = yield* listener((s) =>
		run(
			Deferred.succeed(heldSocket, s).pipe(
				Effect.andThen(Deferred.succeed(held, undefined)),
			),
		),
	)
	yield* Effect.addFinalizer(() =>
		Deferred.poll(heldSocket).pipe(
			Effect.flatMap(
				Option.match({
					onNone: () => Effect.void,
					onSome: (exit) =>
						Effect.flatMap(exit, (s) => Effect.sync(() => s.destroy())),
				}),
			),
		),
	)
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = new URL("../.cache/gateway-tests/", import.meta.url).pathname
	yield* fs.makeDirectory(root, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
	const contractDirectory = path.join(directory, "contract")
	const implementationDirectory = path.join(directory, "implementation")
	yield* Effect.forEach(
		[contractDirectory, implementationDirectory],
		(d) => fs.makeDirectory(d),
		{ discard: true },
	)
	yield* Effect.forEach(
		[contractDirectory, implementationDirectory],
		(d) =>
			fs.writeFileString(
				path.join(d, "package.json"),
				'{"name":"gateway-fixture","version":"1.0.0","type":"module"}',
			),
		{ discard: true },
	)
	const contract = yield* quote(
		new URL("../dist/Contract.js", import.meta.url).href,
	)
	const plugin = yield* quote(
		new URL("../../core/dist/Plugin.js", import.meta.url).href,
	)
	const graft = yield* quote(
		new URL("../../core/dist/Graft.js", import.meta.url).href,
	)
	const lines = yield* quote(
		new URL("../dist/internal/jsonLines.js", import.meta.url).href,
	)
	yield* fs.writeFileString(
		path.join(contractDirectory, "shared.js"),
		`import {Context,Schema} from "effect";import {Rpc,RpcGroup} from "effect/rpc";import * as Contract from ${contract};
 export class Integration extends Context.Service()("gateway/Integration"){}
 export const Config=Schema.Struct({version:Schema.Int,mode:Schema.String,upstream:Schema.Int,gate:Schema.Int});
 export const Service=Contract.service(Integration,RpcGroup.make(Contract.operation("gateway/read",1,Rpc.make("Read",{payload:{city:Schema.String},success:Schema.Struct({version:Schema.Int,term:Schema.Int})}))),{toHandlers:s=>({Read:({city})=>s.read(city)}),fromClient:c=>({read:city=>c.Read({city})})});`,
	)
	for (const [name, declaration] of [
		["provider", "provides:[Service]"],
		["consumer", "inject:[Service]"],
	])
		yield* fs.writeFileString(
			path.join(contractDirectory, name + ".js"),
			`import * as Contract from ${contract};import {Config,Service} from "./shared.js";export default Contract.make({name:"${name}",config:Config,${declaration}});`,
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
		path.join(implementationDirectory, "provider.js"),
		`import {createConnection} from "node:net";import {Deferred,Effect} from "effect";import * as Plugin from ${plugin};import * as Graft from ${graft};import {Config,Service,Integration} from ${shared};
 export default Plugin.make({name:"integration",config:Config,overlap:true,provides:[Service],apply:config=>Effect.gen(function*(){
 if(config.mode==="startup")return yield* Effect.die("Candidate startup failed");
 if(config.mode==="finalizer")yield* Effect.addFinalizer(()=>Effect.callback(()=>{const socket=createConnection({host:"127.0.0.1",port:config.gate},()=>socket.end("finalizer\\n"));return Effect.sync(()=>socket.destroy())}));
 const term=yield* Plugin.term;const crashed=yield* Deferred.make();yield* Plugin.probe("health",Effect.void);
 yield* Plugin.fork(Deferred.await(crashed).pipe(Effect.andThen(Effect.die("Candidate trial failed"))));
 yield* Graft.provide(Integration,{read:city=>Effect.gen(function*(){
 if(city==="held")yield* Effect.callback(resume=>{const socket=createConnection({host:"127.0.0.1",port:config.gate},()=>socket.write("held\\n"));socket.once("data",()=>{socket.destroy();resume(Effect.void)});socket.once("error",cause=>resume(Effect.die(cause)));return Effect.sync(()=>socket.destroy())});
 if(city==="held"&&config.mode==="handler")yield* Effect.sync(()=>{while(true){}});
 if(city==="crash"&&config.mode==="trial")yield* Deferred.succeed(crashed,undefined);
 return {version:config.version,term};
 })})
 })});`,
	)
	yield* fs.writeFileString(
		path.join(implementationDirectory, "consumer.js"),
		`import {createConnection} from "node:net";import {Effect,FiberSet,Schema,Stream} from "effect";import * as Plugin from ${plugin};import * as Lines from ${lines};import {Config,Integration} from ${shared};
 const Input=Schema.fromJsonString(Schema.Struct({id:Schema.String,city:Schema.String}));const encode=Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
 export default Plugin.make({name:"gateway",config:Config,inject:[Integration],apply:config=>Effect.gen(function*(){
 const integration=yield* Integration;const session=yield* Plugin.term;const calls=yield* FiberSet.make();const run=yield* FiberSet.runtime(calls)();
 const socket=yield* Effect.acquireRelease(Effect.callback(resume=>{const s=createConnection({host:"127.0.0.1",port:config.upstream},()=>resume(Effect.succeed(s)));s.once("error",cause=>resume(Effect.die(cause)));return Effect.sync(()=>s.destroy())}),s=>Effect.sync(()=>s.destroy()));
 const incoming=yield* Lines.receive(socket);
 yield* Plugin.fork(Stream.runForEach(incoming,line=>Schema.decodeEffect(Input)(line).pipe(Effect.flatMap(request=>Effect.sync(()=>run(integration.read(request.city).pipe(Effect.flatMap(value=>encode({id:request.id,session,...value})),Effect.flatMap(line=>Lines.write(socket,line)))))))));
 const ready=yield* encode({id:"ready",version:0,term:session,session});yield* Lines.write(socket,ready);
 })});`,
	)
	const provider = yield* Artifact.capture({
		directory: implementationDirectory,
		entry: "provider.js",
		store: path.join(directory, "providers"),
	})
	const consumerArtifact = yield* Artifact.capture({
		directory: implementationDirectory,
		entry: "consumer.js",
		store: path.join(directory, "consumers"),
	})
	const runner =
		placement === "Runner"
			? yield* Units.serveRunner({
					socket: path.relative(".", path.join(directory, "runner.sock")),
					owner: "gateway-owner",
				})
			: undefined
	const target = (version: number, mode: string = "normal") =>
		Units.target({
			artifact: provider,
			contractArtifact,
			contract: "provider.js",
			input: { version, mode, upstream, gate },
			placement,
			...(runner === undefined ? {} : { runner: runner.address }),
		})
	const consumer = Units.target({
		artifact: consumerArtifact,
		contractArtifact,
		contract: "consumer.js",
		input: { version: 0, mode: "normal", upstream, gate },
		placement: "Worker",
	})
	const unrelated = Units.target({
		artifact: provider,
		contractArtifact,
		contract: "provider.js",
		input: { version: 3, mode: "normal", upstream, gate },
		placement: "Worker",
	})

	const layer = Kernel.layer({
		authority: "gateway",
		maxUnits: 8,
		instances: [
			{ id: "integration", target: target(1) },
			{ id: "gateway", target: consumer },
			{ id: "unrelated", target: unrelated },
		],
		bindings: [
			{
				consumer: "gateway",
				provider: "integration",
				service: "gateway/Integration",
			},
		],
	}).pipe(Layer.provide(Units.layer), Layer.provide(NodeServices.layer))
	const call = Effect.fnUntraced(function* (city: string) {
		const connection = yield* Deferred.await(socket)
		const sequence = yield* Ref.getAndUpdate(next, (n) => n + 1)
		const id = globalThis.String(sequence)
		const waiter = yield* Deferred.make<Reply>()
		yield* Ref.update(pending, HashMap.set(id, waiter))
		const frame = yield* json({ id, city })
		yield* Lines.write(connection, frame)
		return yield* Deferred.await(waiter).pipe(
			Effect.ensuring(Ref.update(pending, HashMap.remove(id))),
		)
	})
	return {
		disconnect: runner?.disconnect ?? Effect.void,
		unrelated,
		layer,
		target,
		consumer,
		session: Deferred.await(session),
		call,
		held: Deferred.await(held),
		release: Deferred.await(heldSocket).pipe(
			Effect.flatMap((s) => Lines.write(s, "release")),
		),
		directory,
	}
})
