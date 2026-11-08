import { Effect, FileSystem, Path, Schema } from "effect"

import * as Artifact from "../src/Artifact"

export const budget = {
	total: 30000,
	startup: 5000,
	probe: 1000,
	drain: 1000,
	stop: 1000,
	terminate: 1000,
}
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
export const fixture = Effect.fnUntraced(function* (
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
