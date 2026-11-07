import { once } from "node:events"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { setTimeout as delay } from "node:timers/promises"

// Installed only by an entry function. No process is started when this module is imported.
export const observeExecutions = () => {
	const require = createRequire(import.meta.url)
	const module = require("node:child_process")
	const original = module.spawn
	const records = []
	const record = (unit, kind) => {
		if (records.some((r) => r.unit === unit)) return
		const item = {
			kind,
			unit,
			pid: kind === "child" ? unit.pid : process.pid,
			threadId: kind === "worker" ? unit.threadId : 0,
			startedAt: performance.now(),
			exitedAt: null,
			code: null,
		}
		item.exited = new Promise((resolve) =>
			unit.once("exit", (code) => {
				item.exitedAt = performance.now()
				item.code = code
				resolve(item)
			}),
		)
		records.push(item)
	}
	module.spawn = (...args) => {
		const unit = original(...args)
		record(unit, "child")
		return unit
	}
	syncBuiltinESMExports()
	const onWorker = (unit) => record(unit, "worker")
	process.on("worker", onWorker)
	return {
		records,
		track: (unit, kind) => {
			if (!records.some((r) => r.unit === unit)) record(unit, kind)
		},
		find: (info) =>
			records.findLast((r) =>
				info.threadId
					? r.kind === "worker" && r.threadId === info.threadId
					: r.kind === "child" && r.pid === info.pid,
			),
		async verify() {
			await completed(
				records.map((r) =>
					Promise.race([
						r.exited,
						delay(10000, undefined, { ref: false }).then(() => {
							if (r.exitedAt === null)
								throw new Error(
									`Execution did not exit: ${r.kind} ${r.pid}/${r.threadId}`,
								)
						}),
					]),
				),
			)
			const leftovers = records.filter((r) => {
				if (r.exitedAt === null) return true
				if (r.kind === "worker") return r.unit.threadId !== -1
				try {
					process.kill(r.pid, 0)
					return true
				} catch (error) {
					if (error.code === "ESRCH") return false
					throw error
				}
			})
			if (leftovers.length)
				throw new Error(
					`Leftover executions: ${leftovers.map((r) => r.pid + "/" + r.threadId)}`,
				)
			return {
				started: records.length,
				exited: records.filter((r) => r.exitedAt !== null).length,
				leftovers: leftovers.length,
				identities: records.map(
					({ kind, pid, threadId, startedAt, exitedAt, code }) => ({
						kind,
						pid,
						threadId,
						startedAt,
						exitedAt,
						code,
					}),
				),
			}
		},
		async cleanup() {
			for (const r of records)
				if (r.exitedAt === null) {
					if (r.kind === "worker") await r.unit.terminate()
					else r.unit.kill("SIGKILL")
				}
			await completed(records.map((r) => r.exited))
		},
		restore() {
			module.spawn = original
			syncBuiltinESMExports()
			process.off("worker", onWorker)
		},
	}
}

export const raw = async (implementation, probe) => {
	const { Worker } = await import("node:worker_threads")
	const { fork } = await import("node:child_process")
	const unit =
		implementation === "raw-worker"
			? new Worker(new URL("./remote-raw.mjs", import.meta.url), {
					execArgv: [],
				})
			: fork(new URL("./remote-raw.mjs", import.meta.url), [], {
					execArgv: [],
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				})
	probe?.track(unit, implementation === "raw-worker" ? "worker" : "child")
	let sequence = 0
	const pending = new Map()
	const onMessage = (message) => {
		if (message.ready) return
		const entry = pending.get(message.id)
		if (!entry) throw new Error("Unmatched raw reply")
		pending.delete(message.id)
		entry.resolve(message)
	}
	unit.on("message", onMessage)
	unit.on("error", (error) => {
		for (const entry of pending.values()) entry.reject(error)
		pending.clear()
	})
	const exited = new Promise((resolve) => unit.once("exit", resolve))
	await once(unit, "message")
	const request = (payload) =>
		new Promise((resolve, reject) => {
			const id = ++sequence
			pending.set(id, { resolve, reject })
			if (implementation === "raw-worker") unit.postMessage({ id, ...payload })
			else
				unit.send({ id, ...payload }, (error) => {
					if (error) {
						pending.delete(id)
						reject(error)
					}
				})
		})
	return {
		echo: (text) => request({ text }),
		batch: async (texts) => (await request({ texts })).values,

		async close() {
			if (implementation === "raw-worker") unit.postMessage({ stop: true })
			else unit.send({ stop: true })
			const code = await exited
			if (code !== 0) throw new Error(`Raw transport exited with code ${code}`)
		},
	}
}

// Isolate JSON protocol output from the child runtime's additional default console logger.
// Count its formatted bytes with an inert sink; all structured failures remain in fixture causes.
export const captureNativeStdout = () => {
	const write = process.stdout.write
	let bytes = 0
	let chunks = 0
	let prefix = ""
	process.stdout.write = function (chunk, ...args) {
		bytes +=
			typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
		chunks++
		if (prefix.length < 1024)
			prefix += String(chunk).slice(0, 1024 - prefix.length)
		const callback = args.find((arg) => typeof arg === "function")
		if (callback) queueMicrotask(() => callback())
		return true
	}
	return {
		read: () => ({
			bytes,
			chunks,
			prefix,
			sink: "Formatted native stdout counted in memory; no console/disk sink.",
		}),
		restore: () => {
			process.stdout.write = write
		},
	}
}

export const completed = async (tasks) => {
	const outcomes = await Promise.allSettled(tasks)
	const failures = outcomes
		.filter((r) => r.status === "rejected")
		.map((r) => r.reason)
	if (failures.length)
		throw new AggregateError(failures, "Independent native operations failed")
	return outcomes.map((r) => r.value)
}
