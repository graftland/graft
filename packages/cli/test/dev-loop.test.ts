import {
	Array,
	Clock,
	Config,
	Effect,
	FileSystem,
	Number,
	Ref,
	Schedule,
	Schema,
	Stream,
	String,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"

const quote = Schema.encodeEffect(Schema.fromJsonString(Schema.String))
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const executable = new URL("../.cache/commands/cli/bin.js", import.meta.url)
	.pathname
/** `GRAFT_DEV_LOOP_EDITS` changes the number of saves; the default keeps the suite fast. */
const editCount = Config.Int("GRAFT_DEV_LOOP_EDITS").pipe(
	Config.withDefault(20),
)
const warmup = 5
/** Allowed growth between the warm-up edit and the last edit. */
const limits = { rssBytes: 96 * 1024 * 1024, listeners: 0, artifacts: 0 }

/** Standard output of a short command; empty when the command is unavailable or fails. */
const output = (command: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const child = yield* spawner.spawn(ChildProcess.make(command, args))
			return yield* Stream.mkString(Stream.decodeText(child.stdout))
		}),
	).pipe(Effect.orElseSucceed(() => ""))
/** Resident memory of a process in bytes, from `ps`. */
const rss = (pid: number) =>
	Effect.map(
		output("ps", ["-o", "rss=", "-p", `${pid}`]),
		(text) => globalThis.Number(String.trim(text)) * 1024,
	)
/** TCP listeners the process holds, from `lsof`; zero where `lsof` is unavailable. */
const listeners = (pid: number) =>
	Effect.map(
		output("lsof", ["-a", "-p", `${pid}`, "-iTCP", "-sTCP:LISTEN", "-Fn"]),
		(text) =>
			Array.filter(String.split("\n")(text), String.startsWith("n")).length,
	)

const fixture = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem
	const directory = yield* fs.makeTempDirectoryScoped()
	const plugin = yield* quote(
		new URL("../.cache/integration/plugin.mjs", import.meta.url).href,
	)
	const effect = yield* quote(import.meta.resolve("effect"))
	const write = (version: number) =>
		Effect.gen(function* () {
			yield* fs.makeDirectory(`${directory}/edited`, { recursive: true })
			yield* fs.writeFileString(
				`${directory}/edited/package.json`,
				'{"name":"edited","type":"module"}',
			)
			yield* fs.writeFileString(
				`${directory}/edited/index.mjs`,
				`import {Plugin} from ${plugin};import {Effect} from ${effect};export default Plugin.make({name:"edited",apply:()=>Effect.logInfo("SERVING ${version}")});`,
			)
		})
	yield* write(0)
	yield* fs.writeFileString(
		`${directory}/graft.yml`,
		"- id: edited\n  name: ./edited/index.mjs\n",
	)
	return { fs, directory, write }
})
const spawn = (directory: string, watch: boolean) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const child = yield* spawner.spawn(
			ChildProcess.make(
				process.execPath,
				[
					executable,
					"--no-plugins",
					"start",
					`${directory}/graft.yml`,
					...(watch ? ["--watch"] : []),
				],
				{
					cwd: directory,
					env: { GRAFT_HOME: directory + "/home" },
					extendEnv: true,
				},
			),
		)
		const lines = yield* Ref.make<ReadonlyArray<string>>([])
		yield* child.all.pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.runForEach((line) => Ref.update(lines, Array.append(line))),
			Effect.forkScoped,
		)
		const seen = (text: string) =>
			Ref.get(lines).pipe(
				Effect.repeat({
					schedule: Schedule.spaced("10 millis"),
					until: Array.some(String.includes(text)),
				}),
				Effect.timeout("30 seconds"),
			)
		return { child, seen }
	})

it.live(
	"keeps memory, listeners and captured artifacts bounded over a long editing session and reports reload latency (C9)",
	() =>
		Effect.gen(function* () {
			const edits = yield* editCount
			const f = yield* fixture()
			const started = yield* Clock.currentTimeMillis
			const restart = yield* Effect.scoped(
				Effect.gen(function* () {
					const fresh = yield* spawn(f.directory, false)
					yield* fresh.seen("SERVING 0")
					const ready = yield* Clock.currentTimeMillis
					yield* fresh.child.kill()
					return ready - started
				}),
			)
			const dev = yield* spawn(f.directory, true)
			yield* dev.seen("SERVING 0")
			const sample = Effect.gen(function* () {
				const pid = dev.child.pid
				const artifacts = yield* f.fs
					.readDirectory(`${f.directory}/.graft/artifacts`)
					.pipe(Effect.orElseSucceed(() => []))
				return {
					rss: yield* rss(pid),
					listeners: yield* listeners(pid),
					artifacts: artifacts.length,
				}
			})
			const edit = (version: number) =>
				Effect.gen(function* () {
					const saved = yield* Clock.currentTimeMillis
					yield* f.write(version)
					yield* dev.seen(`SERVING ${version}`)
					const served = yield* Clock.currentTimeMillis
					return served - saved
				})
			const early = yield* Effect.forEach(Array.range(1, warmup), edit)
			const atWarmup = yield* sample
			const late = yield* Effect.forEach(Array.range(warmup + 1, edits), edit)
			const atEnd = yield* sample
			const latencies = Array.appendAll(early, late)
			const sorted = Array.sort(latencies, Number.Order)
			const report = {
				edits,
				restartToServingMs: restart,
				saveToServingMs: {
					median: sorted[Math.floor(sorted.length / 2)] ?? 0,
					p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
					max: sorted[sorted.length - 1] ?? 0,
				},
				atWarmup,
				atEnd,
			}
			const text = yield* encodeReport(report)
			yield* f.fs.makeDirectory(
				new URL("../.cache", import.meta.url).pathname,
				{
					recursive: true,
				},
			)
			yield* f.fs.writeFileString(
				new URL("../.cache/dev-loop.json", import.meta.url).pathname,
				text,
			)
			yield* Effect.logInfo(`dev loop: ${text}`)
			assert.isAtMost(atEnd.rss - atWarmup.rss, limits.rssBytes, text)
			assert.isAtMost(
				atEnd.listeners - atWarmup.listeners,
				limits.listeners,
				text,
			)
			assert.isAtMost(
				atEnd.artifacts - atWarmup.artifacts,
				limits.artifacts,
				text,
			)
			yield* dev.child.kill()
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	180000,
)
