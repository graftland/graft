import { build } from "tsdown"
import { rm, cp, mkdir, writeFile } from "node:fs/promises"

const common = {
	config: false,
	format: "esm",
	fixedExtension: false,
	platform: "node",
	dts: false,
	deps: {
		alwaysBundle: [/^@graftland\/(?:graft|loader|cli)(?:\/|$)/],
		neverBundle: [/^effect(?:\/|$)/, /^@effect\//],
	},
	inputOptions: { resolve: { conditionNames: ["source", "import", "node"] } },
}
export default async function setup(project) {
	await build({
		config: false,
		entry: [new URL("../../cli/src/bin.ts", import.meta.url).pathname],
		outDir: new URL("../../cli/dist", import.meta.url).pathname,
		format: "esm",
		platform: "node",
		fixedExtension: false,
		dts: false,
		unbundle: true,
		deps: { neverBundle: true },
	})
	await build({
		...common,
		entry: [
			"cli",
			"internal/childMain",
			"index",
			"runner/index",
			"Contract",
			"internal/watchdogMain",
			"internal/workerMain",
			"host/worker",
			"host/local",
			"host/websocket",
			"host/auth/mtls",
			"internal/supervisorPlugin",
			"runner/websocket",
			"runner/auth/mtls",
			"host/unix",
			"host/command",
			"host/auth/none",
			"runner/unix",
			"runner/stdio",
			"runner/auth/none",
			"host/auth/bearer",
			"host/auth/jwt",
			"runner/auth/bearer",
			"runner/auth/jwt",
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
			"null-config-contract",
			"empty-config-contract",
			"empty-plugin",
			"plugin",
			"services-contract",
			"services-plugin",
			"loader-entry",
			"entry-host",
			"stdio-echo",
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
	const commandApp = new URL("../.cache/commands-app", import.meta.url).pathname
	await mkdir(commandApp, { recursive: true })
	await writeFile(
		commandApp + "/graft.yml",
		JSON.stringify([
			{ name: new URL("../dist/cli.js", import.meta.url).href, cli: true },
		]),
	)
	const { certificates } =
		await import("../.cache/certificates-helper/certificates.js")
	const directory = await certificates(
		new URL("../.cache/certificates", import.meta.url).pathname,
		new URL("../../cli/dist/bin.js", import.meta.url).pathname,
		new URL("../.cache/commands-app", import.meta.url).pathname,
	)
	project.provide("remoteTls", directory)
	return () => rm(directory, { recursive: true, force: true })
}
