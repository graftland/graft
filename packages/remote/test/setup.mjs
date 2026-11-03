import { build } from "tsdown"
import { rm } from "node:fs/promises"
import { certificates } from "./certificates.mjs"

const common = {
	config: false,
	format: "esm",
	fixedExtension: false,
	platform: "node",
	dts: false,
	deps: {
		alwaysBundle: ["@graftland/graft"],
		neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
	},
	inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
}
export default async function setup(project) {
	await build({
		...common,
		entry: [new URL("../src/bin.ts", import.meta.url).pathname],
		outDir: new URL("../dist", import.meta.url).pathname,
		clean: false,
	})
	await build({
		...common,
		entry: [
			"contract",
			"default-contract",
			"plugin",
			"services-contract",
			"services-plugin",
		].map((name) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname),
		outDir: new URL("../.cache/integration", import.meta.url).pathname,
	})
	const directory = await certificates(
		new URL("../.cache/certificates", import.meta.url).pathname,
	)
	project.provide("remoteTls", directory)
	return () => rm(directory, { recursive: true, force: true })
}
