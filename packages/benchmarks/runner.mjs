import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { cpus, platform, release, totalmem } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { inspect, parseArgs } from "node:util"
import { gzipSync } from "node:zlib"

import { cases, implementations, imports, methodology } from "./catalog.mjs"
import { supported } from "./dist/model.js"
import { report } from "./report.mjs"
import { statistics } from "./statistics.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
export const child = (
	file,
	args,
	timeoutMs = methodology.workerTimeoutMs,
	runToken = "",
) =>
	new Promise((accept, reject) => {
		const started = performance.now()
		const process = spawn(
			globalThis.process.execPath,
			["--expose-gc", file, ...args],
			{
				cwd: directory,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
				env: { ...globalThis.process.env, GRAFT_BENCH_RUN_ID: runToken },
			},
		)
		let stdout = ""
		let stderr = ""
		const timeout = setTimeout(
			() => globalThis.process.kill(-process.pid, "SIGKILL"),
			timeoutMs,
		)
		process.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk
		})
		process.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk
		})
		process.on("error", reject)
		process.on("close", (code, signal) => {
			clearTimeout(timeout)
			if (code !== 0)
				reject(
					new Error(`Worker failed (${code ?? signal}): ${stderr}\n${stdout}`),
				)
			else {
				try {
					accept({
						result: JSON.parse(stdout),
						wallMs: performance.now() - started,
						stderr,
					})
				} catch (error) {
					reject(
						new Error(`Worker returned invalid JSON: ${stdout}\n${stderr}`, {
							cause: error,
						}),
					)
				}
			}
		})
	})
const version = async (name) => {
	const resolver = require
	let current = dirname(resolver.resolve(name))
	for (;;) {
		try {
			const manifest = JSON.parse(
				await readFile(join(current, "package.json"), "utf8"),
			)
			if (manifest.name === name) return manifest.version
		} catch (error) {
			if (error.code !== "ENOENT") throw error
		}
		const parent = dirname(current)
		if (parent === current)
			throw new Error(`Cannot find package manifest: ${name}`)
		current = parent
	}
}
const suiteHash = async () => {
	const hash = createHash("sha256")
	const visit = async (path) => {
		for (const entry of (await readdir(path, { withFileTypes: true })).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			if (["node_modules", "dist", ".cache", "results"].includes(entry.name))
				continue
			const file = join(path, entry.name)
			if (entry.isDirectory()) await visit(file)
			else if (/\.(?:ts|mjs|json)$/.test(file)) {
				hash.update(file.slice(directory.length))
				hash.update(await readFile(file))
			}
		}
	}
	await visit(directory)
	return hash.digest("hex")
}
/** Keeps the start and end of captured stderr; a log flood can otherwise reach tens of megabytes. */
export const excerpt = (text, limit = 8192) =>
	typeof text !== "string" || text.length <= limit
		? text
		: `${text.slice(0, limit / 2)}\n… ${text.length - limit} characters omitted …\n${text.slice(-limit / 2)}`
const importMeasurement = async (implementation, options) => {
	const samples = []
	const processWall = []
	const diagnostics = []
	for (let i = -options.importWarmup; i < options.importSamples; i++) {
		const sample = await child("import-worker.mjs", [imports[implementation]])
		if (i >= 0) {
			samples.push(sample.result.elapsed)
			processWall.push(sample.wallMs)
			if (sample.stderr) diagnostics.push(excerpt(sample.stderr))
		}
	}
	const result = statistics(samples)
	return {
		kind: "timing",
		unit: "ms/import",
		...result,
		opsPerSecond: 1000 / result.mean,
		processWall: statistics(processWall),
		diagnostics,
	}
}
export const ownedProcesses = async (token) => {
	if (!token)
		throw new Error("An ownership token is required for a process audit")
	const found = []
	for (const name of await readdir("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
		try {
			const environment = await readFile(`/proc/${name}/environ`)
			if (
				environment
					.toString()
					.split("\0")
					.includes(`GRAFT_BENCH_RUN_ID=${token}`)
			)
				found.push(Number(name))
		} catch (error) {
			if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error
		}
	}
	return found
}
export const run = async (args = process.argv.slice(2)) => {
	const { values } = parseArgs({
		args,
		options: {
			quick: { type: "boolean", default: false },
			scenario: { type: "string" },
			implementation: { type: "string" },
			output: { type: "string" },
			cycles: { type: "string" },
			help: { type: "boolean" },
		},
	})
	if (values.help) {
		process.stdout.write(
			"Usage: pnpm bench [--quick] [--scenario cold,events] [--implementation graft,cordis] [--cycles 100] [--output results/name]\n",
		)
		return
	}
	const options = { ...(values.quick ? methodology.quick : methodology.full) }
	if (values.cycles !== undefined) {
		options.cycles = Number(values.cycles)
		if (!Number.isSafeInteger(options.cycles) || options.cycles < 1)
			throw new Error("--cycles must be a positive integer")
	}
	const selected = implementations.filter(
		(name) =>
			!values.implementation || values.implementation.split(",").includes(name),
	)
	const specifications = cases(values.quick).filter(
		(spec) =>
			!values.scenario ||
			values.scenario.split(",").some((part) => spec.scenario.includes(part)),
	)
	if (!selected.length || !specifications.length)
		throw new Error("The filters match no benchmark cases")
	const output = resolve(
		directory,
		values.output ?? (values.quick ? ".cache/quick" : "results/latest"),
	)
	const started = performance.now()
	const runToken = randomUUID()
	const git = (...args) =>
		execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
	const data = {
		formatVersion: 1,
		resultFile: `${basename(output)}.json`,
		mode: values.quick ? "quick" : "full",
		generatedAt: new Date().toISOString(),
		wallSeconds: 0,
		options,
		precisionPolicy:
			"Original timing rows start with at least 100 samples and 2 seconds measured time after at least 20 warmups and 1 second warmup time. Continue in the same worker in 2-second batches to 4% RME, 24 seconds measured time or 480 seconds worker wall. Retain every sample and capped result. Repeated precision checks make the nominal 95% interval descriptive, not a sequentially valid confidence guarantee. Remote fixed budgets are unchanged.",
		leftoverExecutions: 0,
		environment: {
			node: process.version,
			v8: process.versions.v8,
			cpu: cpus()[0]?.model,
			logicalCpus: cpus().length,
			os: `${platform()} ${release()}`,
			arch: process.arch,
			totalMemoryBytes: totalmem(),
			gitSha: git("rev-parse", "HEAD"),
			dirty: git("status", "--porcelain") !== "",
			suiteHash: await suiteHash(),
			versions: Object.fromEntries(
				await Promise.all(
					[
						"@graftland/graft",
						"effect",
						"cordis",
						"avvio",
						"emittery",
						"tinybench",
					].map(async (name) => [name, await version(name)]),
				),
			),
			nodeEventEmitter: process.version,
		},
		results: [],
	}
	await mkdir(dirname(output), { recursive: true })
	const save = async () => {
		data.wallSeconds = (performance.now() - started) / 1000
		await writeFile(`${output}.json`, JSON.stringify(data, null, 2) + "\n")
		await writeFile(`${output}.md`, report(data))
	}
	let errors = 0
	for (const spec of specifications)
		for (const implementation of selected) {
			const reason = supported(implementation, spec.scenario)
			if (reason) {
				data.results.push({ spec, implementation, status: "N/A", reason })
				continue
			}
			process.stderr.write(`${spec.scenario}/${spec.size} ${implementation}\n`)
			try {
				const result =
					spec.scenario === "import"
						? {
								result: await importMeasurement(implementation, options),
								stderr: "",
							}
						: await child(
								"worker.mjs",
								[
									JSON.stringify({
										implementation,
										spec,
										quick: values.quick,
										options,
									}),
								],
								methodology.workerTimeoutMs,
								runToken,
							)
				const measurement = result.result
				if (measurement.samples) {
					const sampleDirectory = join(directory, ".cache", "samples", runToken)
					await mkdir(sampleDirectory, { recursive: true })
					const file = `${spec.scenario}-${spec.size}-${implementation}.json.gz`
					await writeFile(
						join(sampleDirectory, file),
						gzipSync(JSON.stringify(measurement.samples)),
					)
					measurement.sampleFile = relative(
						dirname(output),
						join(sampleDirectory, file),
					)
					delete measurement.samples
				}
				data.results.push({
					spec,
					implementation,
					status: "completed",
					measurement,
					diagnostics: excerpt(result.stderr),
				})
			} catch (error) {
				errors++
				data.results.push({
					spec,
					implementation,
					status: "failed",
					error: inspect(error, { depth: null }),
				})
				process.stderr.write(`${inspect(error, { depth: null })}\n`)
			}
			await save()
		}
	const leftovers = await ownedProcesses(runToken)
	data.cleanupAudit = {
		runToken,
		leftoverPids: leftovers,
		leftoverProcesses: leftovers.length,
		verifiedExecutions: data.results.reduce(
			(n, r) => n + (r.measurement?.executions?.exited ?? 0),
			0,
		),
	}
	if (leftovers.length) {
		errors++
		for (const pid of leftovers) process.kill(pid, "SIGKILL")
		data.cleanupAudit.forcedCleanup = leftovers
	}
	data.leftoverExecutions = (await ownedProcesses(runToken)).length
	await save()
	process.stdout.write(
		`${output}.json\n${output}.md\nWall time: ${data.wallSeconds.toFixed(1)} s; failed cases: ${errors}\n`,
	)
	if (errors) process.exitCode = 1
	return data
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	run().catch((error) => {
		process.stderr.write(`${inspect(error, { depth: null })}\n`)
		process.exitCode = 1
	})
