import { Effect, FileSystem, Path, Schema } from "effect"

import * as Artifact from "../src/Artifact"

export const budget = {
	total: 20000,
	startup: 2000,
	probe: 500,
	drain: 500,
	stop: 500,
	terminate: 1000,
}
export const stage = Effect.fnUntraced(function* (
	fault: "none" | "import" | "decode" | "finalizer",
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = new URL("../.cache/native-tests/", import.meta.url).pathname
	yield* fs.makeDirectory(root, { recursive: true })
	const directory = yield* fs.makeTempDirectoryScoped({ directory: root })
	const source = path.join(directory, "source")
	const pluginEntry = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.String),
	)(new URL("../../core/dist/Plugin.js", import.meta.url).href)
	const framework = yield* Schema.encodeEffect(
		Schema.fromJsonString(Schema.String),
	)(new URL("../dist/Contract.js", import.meta.url).href)
	yield* fs.makeDirectory(source)
	yield* fs.writeFileString(
		path.join(source, "package.json"),
		'{"name":"native-unit-fixture","version":"1.0.0","type":"module"}',
	)
	yield* fs.writeFileString(
		path.join(source, "contract.js"),
		`import { Schema } from "effect"; import * as Contract from ${framework}; ${fault === "import" ? "while (true) {}" : ""} export default Contract.make({ name:"native-unit-fixture", config:Schema.Struct({ mode:Schema.String${fault === "decode" ? ".check(Schema.makeFilter(() => { while (true) {} }))" : ""} }) });`,
	)
	yield* fs.writeFileString(
		path.join(source, "plugin.js"),
		`import { Effect, Schema } from "effect"; import * as Plugin from ${pluginEntry}; ${fault === "import" ? "while (true) {}" : ""} export default Plugin.make({ name:"native-unit-fixture",overlap:true,config:Schema.Struct({mode:Schema.String${fault === "decode" ? ".check(Schema.makeFilter(() => { while (true) {} }))" : ""}}),apply:() => Effect.gen(function* () { const term = yield* Plugin.term; if (term < 1) return yield* Effect.die("Missing execution term"); ${fault === "finalizer" ? "yield* Effect.addFinalizer(() => Effect.never)" : ""} }) });`,
	)
	return yield* Artifact.capture({
		directory: source,
		module: "plugin.js",
		store: path.join(directory, "artifacts"),
	})
})
