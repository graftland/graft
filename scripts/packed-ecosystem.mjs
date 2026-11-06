import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { prepare } from "./packed-gateway.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directory = prepare()
const json = (file, value) =>
	writeFileSync(file, JSON.stringify(value, null, 2))
const run = (args) => {
	try {
		return execFileSync("pnpm", args, {
			cwd: directory,
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 16 * 1024 * 1024,
		})
	} catch (cause) {
		throw new Error(
			`${args.join(" ")} failed\n${cause.stdout ?? ""}\n${cause.stderr ?? ""}`,
			{ cause },
		)
	}
}
try {
	writeFileSync(
		join(directory, "graft.yml"),
		"- name: '@graftland/plugin-remote/cli'\n  cli: true\n",
	)
	for (const author of ["alice", "bob", "first-party", "incompatible"]) {
		for (const kind of author === "incompatible"
			? ["plugin"]
			: ["contract", "plugin"]) {
			const staged = join(directory, "authors", author, kind)
			mkdirSync(dirname(staged), { recursive: true })
			cpSync(join(root, "samples/plugin-authors", author, kind), staged, {
				recursive: true,
			})
			const source = readFileSync(join(staged, "index.ts"), "utf8")
			assert(!source.includes("/internal/") && !source.includes("/src/"))
			json(join(staged, "tsconfig.json"), {
				extends: join(directory, "compiler.json"),
				compilerOptions: {
					composite: false,
					incremental: false,
					emitDeclarationOnly: false,
					declarationMap: false,
					sourceMap: false,
					module: "NodeNext",
					moduleResolution: "NodeNext",
					declaration: true,
					outDir: "dist",
					types: ["node"],
				},
				include: ["index.ts"],
			})
			run(["exec", "tsc", "-p", join(staged, "tsconfig.json")])
			if (kind === "plugin") {
				run(["exec", "graft", "remote", "manifest", staged])
				run(["exec", "graft", "remote", "manifest", staged, "--check"])
			}
			run([
				"--dir",
				staged,
				"pack",
				"--pack-destination",
				join(directory, "tarballs"),
			])
			const pkg = JSON.parse(readFileSync(join(staged, "package.json"), "utf8"))
			const tarball = join(
				directory,
				"tarballs",
				`${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`,
			)
			run(["add", "--ignore-scripts", tarball])
		}
	}
	cpSync(
		join(root, "samples/plugin-authors/conformance.mjs"),
		join(directory, "conformance.mjs"),
	)
	process.stdout.write(run(["exec", "node", "--test", "conformance.mjs"]))
} finally {
	rmSync(directory, { recursive: true, force: true })
}
