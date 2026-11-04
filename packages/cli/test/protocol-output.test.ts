import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import process from "node:process"

it.live(
	"finishes asynchronous cleanup before exiting after a broken protocol pipe",
	() =>
		Effect.gen(function* () {
			const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
			const protocol = yield* quote(
				new URL(
					"../.cache/commands/cli/internal/protocolOutput.js",
					import.meta.url,
				).href,
			)
			const platform = yield* quote(
				new URL("../.cache/commands/cli/Application.js", import.meta.url).href,
			)
			const effect = yield* quote(import.meta.resolve("effect"))
			const node = yield* quote(import.meta.resolve("@effect/platform-node"))
			const program = yield* quote(`
import { Effect, Stdio, Stream } from ${effect};
import { NodeRuntime } from ${node};
import { platform } from ${platform};
import { reserve } from ${protocol};
const main = Effect.gen(function* () {
 yield* Effect.addFinalizer(() => Effect.logInfo("CLEANUP_BEGIN").pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.andThen(Effect.logInfo("CLEANUP_END"))));
 yield* Effect.sleep("150 millis");
 const stdio = yield* Stdio.Stdio;
 yield* Stream.run(Stream.succeed(new TextEncoder().encode("frame")).pipe(Stream.concat(Stream.never)), stdio.stdout());
});
reserve(Effect.scoped(main).pipe(Effect.tapCause((cause) => Effect.logError(cause)))).pipe(Effect.provide(platform), NodeRuntime.runMain);
`)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const parent = yield* spawner.spawn(
				ChildProcess.make(process.execPath, [
					"--input-type=module",
					"-e",
					`
import { spawn } from 'node:child_process';
import { text } from 'node:stream/consumers';
const child = spawn(process.execPath, ['--input-type=module', '-e', ${program}], { stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.on('close', code => resolve(code)));
child.stdout.destroy();
const [code, stderr] = await Promise.all([exited, text(child.stderr)]);
console.log(JSON.stringify({ code, stderr }));
`,
				]),
			)
			const output = yield* parent.stdout.pipe(
				Stream.decodeText(),
				Stream.mkString,
			)
			const result = yield* Schema.decodeEffect(
				Schema.fromJsonString(
					Schema.Struct({ code: Schema.Finite, stderr: Schema.String }),
				),
			)(output)
			assert.equal(result.code, 1)
			assert.include(result.stderr, "CLEANUP_BEGIN")
			assert.include(result.stderr, "CLEANUP_END")
			assert.include(result.stderr, "EPIPE", result.stderr)
			assert.notInclude(result.stderr, "Unhandled 'error' event")
			const parentCode = yield* parent.exitCode
			assert.equal(parentCode, 0)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
