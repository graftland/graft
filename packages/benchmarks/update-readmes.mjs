import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { implementations } from "./catalog.mjs"
import { remoteImplementations } from "./remote-catalog.mjs"

export const updateReadmes = async (input = "./results/latest.json") => {
	const data = JSON.parse(
		await readFile(new URL(input, import.meta.url), "utf8"),
	)
	const rows = []
	const remoteRows = []
	for (const scenario of [
		...new Set(data.results.map((row) => row.spec.scenario)),
	]) {
		const size = Math.max(
			...data.results
				.filter((row) => row.spec.scenario === scenario)
				.map((row) => row.spec.size),
		)
		const isRemote = scenario.startsWith("remote-")
		const values = (isRemote ? remoteImplementations : implementations).map(
			(implementation) => {
				const measurement = data.results.find(
					(row) =>
						row.spec.scenario === scenario &&
						row.spec.size === size &&
						row.implementation === implementation,
				)?.measurement
				if (!measurement) return "N/A"
				if (measurement.outcome === "rejected") return "rejected"
				return `${measurement.mean.toFixed(measurement.kind === "memory" ? 0 : 3)}${measurement.rme === null || measurement.rme > 5 ? "*" : ""}`
			},
		)
		const unit =
			scenario === "remote-r7-footprint"
				? "B/entry"
				: scenario === "memory-steady"
					? "B/plugin"
					: scenario === "memory-cycles"
						? "B/batch"
						: "ms"
		const targetRows = isRemote ? remoteRows : rows
		targetRows.push(
			`| ${scenario} | ${size} | ${unit} | ${values.join(" | ")} |`,
		)
	}
	const remoteTable = [
		"| Scenario | Size | Unit | in-process | remote-local | remote-worker | remote-unix | remote-ws | raw-worker | raw-ipc |",
		"| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
		...remoteRows,
	].join("\n")
	const table = [
		"| Scenario | Size | Unit | Graft | cordis | avvio | Effect | Node | emittery |",
		"| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
		...rows,
	].join("\n")
	for (const file of ["README.md", "README.zh-CN.md", "README.zh-TW.md"]) {
		const url = new URL(file, import.meta.url)
		const original = await readFile(url, "utf8")
		await writeFile(
			url,
			original.replace(
				/<!-- results:start -->[\s\S]*?<!-- results:end -->/,
				`<!-- results:start -->\n\n${table}\n\n${remoteTable}\n\n<!-- results:end -->`,
			),
		)
	}
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	updateReadmes(process.argv[2]).catch((error) => {
		process.stderr.write(`${error.stack ?? error}\n`)
		process.exitCode = 1
	})
