import { interpretation } from "./catalog.mjs"
import { remoteInterpretation } from "./remote-catalog.mjs"

const number = (value, digits = 3) =>
	value === null || value === undefined ? "—" : value.toFixed(digits)
export const report = (data) => {
	const lines = [
		"# Graft benchmark results",
		"",
		`Mode: **${data.mode}**. Wall time: **${number(data.wallSeconds, 1)} s**. Generated: ${data.generatedAt}.`,
		"",
		`Node ${data.environment.node}; ${data.environment.cpu}; ${data.environment.os}; ${data.environment.arch}.`,
		"",
		`Git: ${data.environment.gitSha} (dirty: ${data.environment.dirty}); suite SHA-256: ${data.environment.suiteHash}.`,
		"",
		`Versions: ${Object.entries(data.environment.versions)
			.map(([name, version]) => `${name} ${version}`)
			.join(", ")}.`,
		"",
		"Timing mean/p50/p99 are milliseconds per batch. Ops/s uses individual service calls or dispatches for hot batches, and complete scenario operations otherwise. Ratio = Graft mean / competitor mean; above 1 means Graft takes longer. Remote uses the in-process reference. Ratios compare means, not causality. Memory ratios are omitted because signed heap deltas can cross zero.",
		"",
		"Remote tables also show p999. Startup includes the first consumer call; hot Remote calls reuse a live fixture. Runner setup is outside entry startup. R7 includes startup timing as a second observation of the same isolated memory scenario. Native stdout formatting is retained and drained into a counted in-memory sink; the host structured logger counts without console or disk I/O.",
		"",
		"RME is the relative 95% margin of error. Rows above 5% are marked **noisy**; quick mode is a smoke check. Percentiles describe samples in this run, not production tail latency. Repeated iterations share one worker per case; imports alone get a new process per sample. No claim of process-level statistical independence is made.",
		"",
		`Source decisions, constants, completion barriers and semantic limits: [SOURCES.md](../SOURCES.md). Raw sample-file references, heap checkpoints, errors and environment details: [JSON](${data.resultFile ?? "latest.json"}).`,
		"",
	]
	if (data.precisionPolicy) lines.push(data.precisionPolicy, "")
	for (const scenario of [
		...new Set(data.results.map((row) => row.spec.scenario)),
	]) {
		lines.push(
			`## ${scenario}`,
			"",
			interpretation[scenario] ?? remoteInterpretation[scenario],
			"",
			"| Size | Implementation | Mean | p50 | p99 | p999 | Ops/s | RME | Reference / this | Status |",
			"| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
		)
		for (const row of data.results.filter(
			(entry) => entry.spec.scenario === scenario,
		)) {
			const measurement = row.measurement
			const graft = data.results.find(
				(entry) =>
					entry.spec.scenario === scenario &&
					entry.spec.size === row.spec.size &&
					entry.implementation ===
						(scenario.startsWith("remote-") ? "in-process" : "graft"),
			)?.measurement
			if (!measurement) {
				lines.push(
					`| ${row.spec.size} | ${row.implementation} | — | — | — | — | — | — | — | ${row.status}: ${(row.reason ?? row.error ?? "").replaceAll("|", "/").replaceAll("\n", " ")} |`,
				)
				continue
			}
			const ratio =
				measurement.kind === "memory" ||
				!graft ||
				row.implementation === "graft" ||
				row.implementation === "in-process" ||
				measurement.outcome === "rejected"
					? "—"
					: `${(graft.mean / measurement.mean).toPrecision(3)}×`
			const status =
				measurement.outcome === "rejected"
					? `rejected; ${measurement.boundaryCleanup?.length ?? 0} cleanup causes retained`
					: measurement.rme === null || measurement.rme > 5
						? "noisy"
						: "ok"
			const unit = measurement.kind === "memory" ? ` ${measurement.unit}` : ""
			lines.push(
				`| ${row.spec.size} | ${row.implementation} | ${number(measurement.mean)}${unit} | ${number(measurement.p50)} | ${number(measurement.p99)} | ${number(measurement.p999)} | ${number(measurement.opsPerSecond, 0)} | ${number(measurement.rme, 1)}% | ${ratio} | ${status} |`,
			)
		}
		if (scenario.startsWith("remote-"))
			lines.push(...remoteDetails(data, scenario))
		if (scenario === "memory-cycles")
			lines.push(
				"",
				"A positive retained delta alone is not a leak finding. Use the per-sample checkpoint slopes in JSON and repeat at larger cycle counts before drawing that conclusion.",
			)
		lines.push("")
	}
	if (data.cleanupAudit)
		lines.push(
			"## Execution ownership audit",
			"",
			`Verified native exits: ${data.cleanupAudit.verifiedExecutions}. Leftover processes before cleanup: ${data.cleanupAudit.leftoverProcesses}; after cleanup: ${data.leftoverExecutions}. Ownership token: ${data.cleanupAudit.runToken}.`,
			"",
		)
	return lines.join("\n")
}

const average = (items) =>
	items.length ? items.reduce((s, n) => s + n, 0) / items.length : null
const remoteDetails = (data, scenario) => {
	const rows = data.results.filter(
		(r) => r.spec.scenario === scenario && r.measurement,
	)
	const lines = [""]
	if (scenario === "remote-r7-footprint") {
		lines.push(
			"Sequential startup observed in the same R7 samples:",
			"",
			"| N | Connection | Mean, ms | p50 | p99 | Ops/s (start N) | RME |",
			"| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
		)
		for (const r of rows) {
			const start = r.measurement.startup
			if (start)
				lines.push(
					`| ${r.spec.size} | ${r.implementation} | ${number(start.mean)} | ${number(start.p50)} | ${number(start.p99)} | ${number(1000 / start.mean)} | ${number(start.rme, 1)}% |`,
				)
		}
		lines.push("")
		lines.push(
			"Startup and native memory observations (RSS and heap in MiB; child RSS is an absolute per-process value, host deltas are signed):",
			"",
			"| N | Connection | Start N, ms | Host heap/entry | Host RSS delta/entry | Child RSS/process | Isolate heap |",
			"| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
		)
		for (const r of rows) {
			const o = r.measurement.observations
			const avg = (key) => average(o.map((x) => x[key]))
			lines.push(
				`| ${r.spec.size} | ${r.implementation} | ${number(avg("startMs"))} | ${number(avg("hostHeapPerEntry") / 1048576)} | ${number(avg("hostRssDeltaPerEntry") / 1048576)} | ${o[0].processRssPerEntry === null ? "N/A" : number(avg("processRssPerEntry") / 1048576)} | ${number(avg("isolateHeapPerEntry") / 1048576)} |`,
			)
		}
		lines.push(
			"",
			"Individual worker RSS is N/A because all workers share process RSS. Host RSS delta/entry is only an aggregate estimate. Runner heap/RSS observations are a combined host+runner substitute because the loopback server runs in the same process. Each full-run footprint/startup point has three independent roots; RME on the main heap table exposes its uncertainty. These measurements do not establish a leak.",
		)
	}
	if (scenario === "remote-r8-loop") {
		lines.push(
			"| Connection | CPU call mean, ms | Loop delay p99 mean, ms | Worst loop stall, ms | Unrelated call mean, ms |",
			"| --- | ---: | ---: | ---: | ---: |",
		)
		for (const r of rows) {
			const o = r.measurement.observations
			lines.push(
				`| ${r.implementation} | ${number(r.measurement.mean)} | ${number(average(o.map((x) => x.eventLoopP99Ms)))} | ${number(Math.max(...o.map((x) => x.eventLoopMaxMs)))} | ${number(average(o.map((x) => x.unrelatedMs)))} |`,
			)
		}
	}
	if (scenario === "remote-r9-logs") {
		lines.push(
			"| Attempts | Connection | Production rate/s | Received | Dropped | Drop warnings | Warnings/s | Host thread CPU, ms | Drain+stop, ms |",
			"| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		)
		for (const r of rows) {
			const o = r.measurement.observations
			const avg = (key) => average(o.map((x) => x[key]))
			lines.push(
				`| ${r.spec.size} | ${r.implementation} | ${number(avg("productionPerSecond"), 0)} | ${number(avg("received"), 0)} | ${number(avg("dropped"), 0)} | ${number(avg("warnings"), 1)} | ${number(avg("warningsPerSecond"), 1)} | ${number(avg("hostThreadCpuMs"))} | ${number(avg("drainAndStopMs"))} |`,
			)
		}
		lines.push(
			"",
			"Counts and rates are means of repetitions. Received + dropped equals attempts in every repetition. Main timing is a substitute: production plus verified drain/stop, with a zero-log control. Host thread CPU uses process.threadCpuUsage; companion process.cpuUsage data in JSON includes worker execution. Runner thread CPU is a combined host+runner substitute. Native console formatting is part of Remote's default child runtime.",
		)
	}
	if (scenario === "remote-r10-failure") {
		lines.push(
			"| Connection | Notice to Failed, ms | Native exit to Failed, ms | Notice to consumer stopped, ms | Native exit code |",
			"| --- | ---: | ---: | ---: | ---: |",
		)
		for (const r of rows) {
			const o = r.measurement.observations
			lines.push(
				`| ${r.implementation} | ${number(r.measurement.mean)} | ${number(average(o.map((x) => x.nativeExitToFailedMs)))} | ${number(average(o.map((x) => x.noticeToConsumerStopMs)))} | 73 |`,
			)
		}
	}
	return lines
}
