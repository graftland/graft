import { execFileSync } from "node:child_process"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { assert, it } from "vitest"

import {
	checkWorkspace,
	forgottenExports,
	publicPackages,
} from "./public-api.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function fixture(files, run) {
	const cache = join(root, ".cache/public-api-cases")
	mkdirSync(cache, { recursive: true })
	const directory = mkdtempSync(join(cache, "case-"))
	try {
		for (const [name, text] of Object.entries(files)) {
			const file = join(directory, name)
			mkdirSync(dirname(file), { recursive: true })
			writeFileSync(file, text)
		}
		const config = join(directory, "tsconfig.json")
		writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: {
					module: "esnext",
					moduleResolution: "bundler",
					strict: true,
					noEmit: true,
					skipLibCheck: true,
				},
				files: Object.keys(files).filter((file) => file.endsWith(".d.ts")),
			}),
		)
		return run(
			forgottenExports(config, [
				{
					name: "fixture",
					file: join(directory, "index.d.ts"),
					root: directory,
				},
			]),
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

it("keeps every published entry's signature publicly nameable", () => {
	assert.lengthOf(publicPackages(root), 12)
	assert.deepEqual(checkWorkspace(root), [])
})

it("imports the public trust entry independently of the package barrel", () => {
	const output = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'import * as Trust from "@graftland/graft/Trust"; console.log(typeof Trust.register, typeof Trust.Projection, "service" in Trust, "immutable" in Trust, "enabled" in Trust)',
		],
		{ cwd: join(root, "packages/core"), encoding: "utf8" },
	)
	assert.equal(output.trim(), "function function false false false")
})

it("imports the Remote policy service through its independent public entry", () => {
	const output = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'import { install, Policy, Service } from "@graftland/plugin-remote/Policy"; console.log(typeof install, typeof Policy, typeof Service)',
		],
		{ cwd: join(root, "packages/plugin-remote"), encoding: "utf8" },
	)
	assert.equal(output.trim(), "function function function")
})

it("emits unannotated consumer declarations using only public entry paths", () => {
	const declaration = readFileSync(
		join(root, ".cache/public-api/consumer/index.d.ts"),
		"utf8",
	)
	for (const name of [
		"plain",
		"configured",
		"injected",
		"configuredAndInjected",
		"service",
		"layer",
		"event",
		"middleware",
		"descriptor",
		"contract",
		"declaredError",
		"remote",
		"loader",
		"include",
		"group",
		"resolver",
		"load",
		"loadFile",
		"authenticator",
		"credentials",
		"connector",
		"listener",
	])
		assert.include(declaration, `export declare const ${name}:`)
	const directory = join(root, ".cache/public-api/consumer")
	for (const file of readdirSync(directory).filter((file) =>
		file.endsWith(".d.ts"),
	)) {
		const output = readFileSync(join(directory, file), "utf8")
		assert.notInclude(output, "/internal/", file)
		assert.notInclude(output, "/src/", file)
	}
	assert.include(declaration, "export default")
})

it("rejects an unexported type in the entry itself", () =>
	fixture(
		{
			"index.d.ts":
				"interface Hidden { value: string }; export declare function make(): Hidden; export {}",
		},
		(failures) => {
			assert.lengthOf(failures, 1)
			assert.include(failures[0], "unexported type Hidden")
		},
	))

it("follows transitive references through public interfaces", () =>
	fixture(
		{
			"index.d.ts":
				'import { Hidden } from "./internal/model"; export interface Public { child: Hidden }; export declare function make(): Public',
			"internal/model.d.ts": "export class Hidden { private brand }",
		},
		(failures) => {
			assert.lengthOf(failures, 1)
			assert.include(failures[0], "unexported type Hidden")
		},
	))

it("accepts namespace and renamed re-exports of types stored internally", () =>
	fixture(
		{
			"index.d.ts":
				'export * as Models from "./internal/model"; export type { Hidden as Named } from "./internal/model"; import { Hidden } from "./internal/model"; export declare function make(): Hidden',
			"internal/model.d.ts": "export class Hidden { private brand }",
		},
		(failures) => assert.deepEqual(failures, []),
	))

it("does not export a class's private implementation types", () =>
	fixture(
		{
			"index.d.ts":
				"export declare class Public { private state; value: string }",
		},
		(failures) => assert.deepEqual(failures, []),
	))

for (const published of [false, true]) {
	it(`${published ? "accepts" : "rejects"} a dependency type ${published ? "re-exported publicly" : "hidden by its exports"}`, () =>
		fixture(
			{
				"index.d.ts":
					'import { Hidden } from "./node_modules/dependency/internal/model"; export declare function make(): Hidden',
				"node_modules/dependency/package.json": JSON.stringify({
					name: "dependency",
					exports: { ".": "./index.js", "./*": "./*.js", "./internal/*": null },
				}),
				"node_modules/dependency/index.d.ts": published
					? 'export type { Hidden } from "./internal/model"'
					: "export {}",
				"node_modules/dependency/internal/model.d.ts":
					"export interface Hidden { value: string }",
			},
			(failures) => {
				if (published) assert.deepEqual(failures, [])
				else {
					assert.lengthOf(failures, 1)
					assert.include(failures[0], "unexported type Hidden")
				}
			},
		))
}

it("skips artifact directories without hiding invalid package manifests", () => {
	const cache = join(root, ".cache/public-api-cases")
	mkdirSync(cache, { recursive: true })
	const directory = mkdtempSync(join(cache, "workspace-"))
	try {
		mkdirSync(join(directory, "packages/old/dist"), { recursive: true })
		mkdirSync(join(directory, "packages/current"), { recursive: true })
		const manifest = join(directory, "packages/current/package.json")
		writeFileSync(manifest, '{"name":"current"}')
		assert.deepEqual(
			publicPackages(directory).map(({ manifest }) => manifest.name),
			["current"],
		)
		writeFileSync(manifest, "invalid")
		assert.throws(() => publicPackages(directory), SyntaxError)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
})

it("keeps shared Graft runtime packages as peers with development copies", () => {
	for (const { manifest } of publicPackages(root)) {
		assert.isString(manifest.engines?.node, `${manifest.name}: Node engine`)
		for (const name of [
			"@graftland/graft",
			"@graftland/loader",
			"@graftland/cli",
		]) {
			assert.isUndefined(
				manifest.dependencies?.[name],
				`${manifest.name}: ${name} must be a peer`,
			)
			if (manifest.peerDependencies?.[name] !== undefined)
				assert.isString(
					manifest.devDependencies?.[name],
					`${manifest.name}: ${name} development copy`,
				)
		}
	}
})
