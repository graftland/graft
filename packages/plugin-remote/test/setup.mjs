import { cp, mkdir, rm, writeFile } from "node:fs/promises"

import { build } from "tsdown"

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
		// Keep test builds out of dist: CI packs dist after the tests run.
		outDir: new URL("../../cli/.cache/plugin-remote", import.meta.url).pathname,
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
			"internal/publicationMain",
			"host/worker",
			"host/local",
			"host/websocket",
			"host/auth/mtls",
			"runner/supervisor",
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
			"unit-contract",
			"unit-plugin",
			"transition-contract",
			"transition-plugin",
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
	const implementation = installation + "/node_modules/remote-implementation"
	await mkdir(implementation, { recursive: true })
	await cp(
		new URL("../.cache/integration", import.meta.url).pathname,
		implementation,
		{ recursive: true },
	)
	await writeFile(
		implementation + "/package.json",
		JSON.stringify({
			name: "remote-implementation",
			version: "2.0.0",
			type: "module",
			exports: "./services-plugin.js",
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
		new URL("../../cli/.cache/plugin-remote/bin.js", import.meta.url).pathname,
		new URL("../.cache/commands-app", import.meta.url).pathname,
	)
	project.provide("remoteTls", directory)
	return () => rm(directory, { recursive: true, force: true })
}
