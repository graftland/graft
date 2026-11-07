import { Array, Effect, FileSystem, Schema, Stream, String } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"

const commands = new URL("../.cache/commands/", import.meta.url)
const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

describe("built CLI command loading", () => {
	for (const args of [
		["--help"],
		["start", "--help"],
		["schema", "--help"],
		["add", "invalid!"],
		["remove", "invalid!"],
		["create", "project", "--no-install", "--no-git"],
	]) {
		it.live(
			`loads only the selected handler for ${Array.join(args, " ")}`,
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const directory = yield* fs.makeTempDirectoryScoped()
					const base = yield* quote(commands.href)
					const hook = `${directory}/trace.mjs`
					yield* fs.writeFileString(
						hook,
						`
import { registerHooks } from "node:module";
const base = ${base};
registerHooks({
 resolve(specifier, context, next) {
  if (specifier === "@graftland/hmr" || specifier === "@graftland/loader") throw new Error("Unexpected runtime dependency: " + specifier);
  if (specifier === "@graftland/create") return next(new URL("create/index.js", base).href, context);
  if (specifier === "@graftland/create/Command") return next(new URL("create/Command.js", base).href, context);
  if (specifier === "@graftland/package-manager") return next(new URL("package-manager/index.js", base).href, context);
  if (specifier === "@graftland/package-manager/PackageManagerDeclaration") return next(new URL("package-manager/PackageManagerDeclaration.js", base).href, context);
  return next(specifier, context);
 },
 load(url, context, next) { console.error("LOADED " + url); return next(url, context); }
});
`,
					)
					const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
					const child = yield* spawner.spawn(
						ChildProcess.make(
							process.execPath,
							[
								"--import",
								hook,
								new URL("cli/bin.js", commands).pathname,
								...args,
							],
							{ cwd: directory },
						),
					)
					const output = yield* child.all.pipe(
						Stream.decodeText(),
						Stream.runCollect,
						Effect.map((parts) => Array.join(parts, "")),
					)
					const code = yield* child.exitCode
					assert.strictEqual(
						code,
						args[0] === "add" || args[0] === "remove" ? 1 : 0,
						output,
					)
					assert.isFalse(
						String.includes("Unexpected runtime dependency")(output),
						output,
					)
					assert.isFalse(String.includes("/Start.js")(output), output)
					assert.strictEqual(
						String.includes("/Manage.js")(output),
						args[0] === "add" || args[0] === "remove",
						output,
					)
					if (Array.contains(args, "--help"))
						assert.isFalse(
							String.includes("/package-manager/index.js")(output),
							output,
						)
					if (args[0] === "create") {
						const created = yield* fs.exists(`${directory}/project/graft.yml`)
						assert.isTrue(created)
					}
				}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
		)
	}
})
