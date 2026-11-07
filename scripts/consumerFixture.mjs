import { execFileSync } from "node:child_process"
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { publicPackages } from "./public-api.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const json = (file, value) =>
	writeFileSync(file, JSON.stringify(value, null, 2))
const run = (command, args, cwd) => {
	try {
		return execFileSync(command, args, {
			cwd,
			stdio: "pipe",
			timeout: 240_000,
			maxBuffer: 16 * 1024 * 1024,
		})
	} catch (cause) {
		throw new Error(
			`${command} ${args.join(" ")} failed:
${cause.stdout?.toString() ?? ""}
${cause.stderr?.toString() ?? ""}`,
			{ cause },
		)
	}
}

/** Packs copies of release files; never rewrites workspace manifests. */
export function prepare() {
	const directory = mkdtempSync(join(tmpdir(), "graft-consumer-"))
	try {
		const tarballs = join(directory, "tarballs")
		mkdirSync(tarballs)
		const dependencies = {
			effect: "4.1.2",
			"@modelcontextprotocol/sdk": "1.32.2",
			"@effect/platform-node": "4.1.2",
			"@types/node": "26.6.6",
			"@types/ws": "8.18.2",
			ws: "8.22.1",
			typescript: "7.0.2",
			"@effect/tsgo": "0.64.1",
		}
		const overrides = {}
		for (const { directory: source, manifest } of publicPackages(root).filter(
			({ manifest }) =>
				[
					"@graftland/graft",
					"@graftland/loader",
					"@graftland/cli",
					"@graftland/plugin-remote",
					"@graftland/plugin-mcp-server",
					"@graftland/plugin-http",
					"@graftland/hmr",
					"@graftland/create",
					"@graftland/package-manager",
				].includes(manifest.name),
		)) {
			const staged = join(directory, "release", manifest.name.split("/").at(-1))
			mkdirSync(staged, { recursive: true })
			cpSync(join(source, "dist"), join(staged, "dist"), { recursive: true })
			const release = {
				...manifest,
				exports: manifest.publishConfig?.exports ?? manifest.exports,
			}
			delete release.scripts
			delete release.devDependencies
			delete release.publishConfig
			delete release.files
			for (const field of [
				"dependencies",
				"peerDependencies",
				"optionalDependencies",
			]) {
				if (release[field])
					release[field] = Object.fromEntries(
						Object.entries(release[field]).map(([name, version]) => [
							name,
							version.startsWith("workspace:") ? "0.0.0" : version,
						]),
					)
			}
			json(join(staged, "package.json"), release)
			run("pnpm", ["pack", "--pack-destination", tarballs], staged)
			const tar = join(
				tarballs,
				manifest.name.replace("@", "").replace("/", "-") + "-0.0.0.tgz",
			)
			dependencies[manifest.name] = "file:" + tar
			overrides[manifest.name] = "file:" + tar
		}
		json(join(directory, "package.json"), {
			name: "isolated-gateway-consumer",
			private: true,
			type: "module",
			dependencies,
		})
		json(join(directory, "pnpm-workspace.yaml"), { packages: [], overrides })
		run("pnpm", ["install", "--ignore-scripts"], directory)
		run(
			"pnpm",
			["exec", "effect-tsgo", "patch", "--typescript", "--no-oxlint"],
			directory,
		)
		cpSync(join(root, "tsconfig.base.json"), join(directory, "compiler.json"))
		return directory
	} catch (error) {
		rmSync(directory, { recursive: true, force: true })
		throw error
	}
}
