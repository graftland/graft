import { build } from "tsdown"
import { rm, cp, mkdir, writeFile } from "node:fs/promises"

const common = {
	config: false,
	format: "esm",
	fixedExtension: false,
	platform: "node",
	dts: false,
	deps: {
		alwaysBundle: ["@graftland/graft", "@graftland/loader"],
		neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
	},
	inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
}
export default async function setup(project) {
	await build({
		...common,
		entry: [
			"bin",
			"watchdog",
			"host/local",
			"host/tls",
			"host/auth/mtls",
			"runner/supervisor",
			"runner/tls",
			"runner/auth/mtls",
		].map((name) => new URL(`../src/${name}.ts`, import.meta.url).pathname),
		outDir: new URL("../dist", import.meta.url).pathname,
		root: new URL("../src", import.meta.url).pathname,
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
			"loader-entry",
		].map((name) => new URL(`./fixtures/${name}.ts`, import.meta.url).pathname),
		outDir: new URL("../.cache/integration", import.meta.url).pathname,
	})
	const installation = new URL("../.cache/runner-install", import.meta.url)
		.pathname
	const fixture = installation + "/node_modules/remote-fixture"
	await rm(installation, { recursive: true, force: true })
	await mkdir(fixture, { recursive: true })
	await cp(
		new URL("../.cache/integration", import.meta.url).pathname,
		fixture,
		{ recursive: true },
	)
	await writeFile(
		fixture + "/package.json",
		JSON.stringify({
			name: "remote-fixture",
			version: "1.0.0",
			type: "module",
			exports: "./services-contract.js",
		}),
	)
	project.provide("remoteRoot", installation)
	await build({
		...common,
		entry: [new URL("./certificates.ts", import.meta.url).pathname],
		outDir: new URL("../.cache/certificates-helper", import.meta.url).pathname,
	})
	const { certificates } =
		await import("../.cache/certificates-helper/certificates.js")
	const directory = await certificates(
		new URL("../.cache/certificates", import.meta.url).pathname,
		new URL("../dist/bin.js", import.meta.url).pathname,
	)
	project.provide("remoteTls", directory)
	return () => rm(directory, { recursive: true, force: true })
}
