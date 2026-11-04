import { API, SymbolFlags } from "typescript/unstable/sync"
import { SyntaxKind } from "typescript/unstable/ast"
import {
	readFileSync,
	readdirSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	realpathSync,
} from "node:fs"
import { dirname, join, resolve, relative, sep } from "node:path"

const json = (file) => JSON.parse(readFileSync(file, "utf8"))

const leaves = (value) =>
	typeof value === "string"
		? [value]
		: value === null
			? []
			: Object.values(value).flatMap(leaves)
const declarationPath = (file) =>
	/\.d\.[cm]?ts$/.test(file)
		? file
		: file
				.replace(/\.([cm]?)js$/, ".d.$1ts")
				.replace(/(?<!\.d)\.tsx?$/, ".d.ts")
const matches = (pattern, value) => {
	const [prefix, suffix] = pattern.split("*")
	return suffix === undefined
		? pattern === value
		: value.startsWith(prefix) && value.endsWith(suffix)
}
function isPublicFile({ directory, manifest }, file) {
	const path = "./" + relative(directory, file).split(sep).join("/")
	if (!manifest.exports)
		return matches(
			declarationPath(
				manifest.types ?? manifest.typings ?? manifest.main ?? "index.js",
			).replace(/^(?!\.\/)/, "./"),
			path,
		)
	const exports =
		typeof manifest.exports === "string"
			? { ".": manifest.exports }
			: manifest.exports
	return Object.entries(exports).some(([key, value]) =>
		leaves(value).some((entry) => {
			const pattern = declarationPath(entry)
			if (!matches(pattern, path)) return false
			const star = pattern.indexOf("*")
			const subpath =
				star === -1
					? key
					: key.replace(
							"*",
							path.slice(star, path.length - pattern.slice(star + 1).length),
						)
			return !Object.entries(exports).some(
				([blocked, target]) => target === null && matches(blocked, subpath),
			)
		}),
	)
}

/** Use the same package selection as the release script. */
export function publicPackages(root) {
	return readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			directory: join(root, "packages", entry.name),
			manifest: json(join(root, "packages", entry.name, "package.json")),
		}))
		.filter(({ manifest }) => !manifest.private)
}

function dependencyFiles(packages) {
	const directories = new Set(
		packages.flatMap(({ directory, manifest }) =>
			Object.keys({
				...manifest.dependencies,
				...manifest.peerDependencies,
			}).flatMap((name) => {
				const location = join(directory, "node_modules", name)
				return existsSync(location) && !name.startsWith("@graftland/")
					? [realpathSync(location)]
					: []
			}),
		),
	)
	return [...directories].flatMap((directory) => {
		const owner = { directory, manifest: json(join(directory, "package.json")) }
		return readdirSync(directory, { recursive: true })
			.filter((file) => /\.d\.[cm]?ts$/.test(file))
			.map((file) => join(directory, file))
			.filter((file) => isPublicFile(owner, file))
	})
}

/** Inspect emitted signatures, following symbol aliases rather than guessing from import paths. */
export function forgottenExports(config, entries) {
	const api = new API({ cwd: dirname(config) })
	try {
		const snapshot = api.updateSnapshot({ openProjects: [config] })
		try {
			const project = snapshot.getProject(config)
			if (!project) throw new Error(`No declaration project: ${config}`)
			const { checker, program } = project
			const canonical = (symbol) =>
				symbol?.flags & SymbolFlags.Alias
					? checker.getAliasedSymbol(symbol)
					: symbol
			const exported = new Map()
			const exposed = new Set()
			const packageName = (name) =>
				name
					.split("/")
					.slice(0, name.startsWith("@") ? 2 : 1)
					.join("/")
			const expose = (symbol, path, owner) => {
				const resolved = canonical(symbol)
				if (!resolved || exposed.has(`${owner}:${resolved.id}`)) return
				exposed.add(`${owner}:${resolved.id}`)
				if (!exported.has(resolved.id)) exported.set(resolved.id, new Set())
				exported.get(resolved.id).add(owner)
				if (resolved.flags & SymbolFlags.Module)
					for (const child of checker.getExportsOfModule(resolved))
						expose(child, `${path}.${child.name}`, owner)
			}
			for (const { file, name } of entries) {
				const source = program.getSourceFile(file)
				if (!source) throw new Error(`Missing declaration entry: ${file}`)
				const symbol = checker.getSymbolAtLocation(source)
				if (symbol) expose(symbol, name, packageName(name))
			}
			const dependencies = new Map()
			const dependency = (file) => {
				if (!file.includes(`${sep}node_modules${sep}`)) return undefined
				const locate = (directory) => {
					if (directory === dirname(directory)) return undefined
					const manifest = join(directory, "package.json")
					if (existsSync(manifest))
						return { directory, manifest: json(manifest) }
					return locate(dirname(directory))
				}
				if (!dependencies.has(dirname(file)))
					dependencies.set(dirname(file), locate(dirname(file)))
				return dependencies.get(dirname(file))
			}
			for (const file of program.getSourceFileNames()) {
				const owner = dependency(file)
				if (!owner || !isPublicFile(owner, file)) continue
				const source = program.getSourceFile(file)
				const symbol = checker.getSymbolAtLocation(source)
				if (symbol) expose(symbol, owner.manifest.name, owner.manifest.name)
			}

			const seen = new Set()
			const missing = new Map()
			const roots = entries.map(({ root }) => root + sep)
			const local = (symbol) =>
				symbol.declarations.some((handle) => {
					const file = handle.resolve(project)?.getSourceFile().fileName
					return (
						file &&
						!dependency(file) &&
						roots.some((root) => file.startsWith(root))
					)
				})
			const inspect = (symbol, origin, owner) => {
				const resolved = canonical(symbol)
				if (!resolved || seen.has(`${owner}:${resolved.id}`)) return
				const owned = local(resolved)
				const source = resolved.declarations[0]
					?.resolve(project)
					?.getSourceFile().fileName
				const declarationOwner =
					source &&
					(dependency(source)?.manifest.name ??
						entries.find((entry) => source.startsWith(entry.root + sep))?.name)
				const visible =
					exported.get(resolved.id)?.has(owner) ||
					(declarationOwner &&
						exported.get(resolved.id)?.has(packageName(declarationOwner)))
				const foreign = resolved.declarations.some((handle) => {
					const file = handle.resolve(project)?.getSourceFile().fileName
					return (
						file &&
						dependency(file) &&
						dependency(file).manifest.name !== "@types/node" &&
						!program.getSourceFileMetadata(file)?.isDefaultLibrary
					)
				})
				if (!owned && !foreign) return
				seen.add(`${owner}:${resolved.id}`)
				if (
					resolved.flags &
						(SymbolFlags.Interface |
							SymbolFlags.Class |
							SymbolFlags.TypeAlias |
							SymbolFlags.Enum |
							SymbolFlags.Module) &&
					!visible
				) {
					const declaration = resolved.declarations[0]
						.resolve(project)
						.getSourceFile()
					missing.set(
						resolved.id,
						`${origin} references unexported type ${resolved.name} (${relative(dirname(config), declaration.fileName)})`,
					)
				}
				// Dependencies own their own signatures; validate the referenced symbol, not their private implementation graph.
				if (!owned) return
				if (resolved.flags & SymbolFlags.Module) {
					for (const child of checker.getExportsOfModule(resolved))
						inspect(child, `${origin}.${child.name}`, owner)
					return
				}
				for (const handle of resolved.declarations) {
					const node = handle.resolve(project)
					if (node) visit(node, origin, owner)
				}
			}
			const reference = (node, origin, owner) => {
				const symbol = checker.getSymbolAtLocation(node)
				if (!symbol || checker.isUnknownSymbol(canonical(symbol))) {
					missing.set(
						`${node.getSourceFile().fileName}:${node.pos}`,
						`${origin} contains an unresolved type reference: ${node.getText()}`,
					)
				} else inspect(symbol, origin, owner)
			}
			const visit = (node, origin, owner) => {
				if (node.kind === SyntaxKind.TypeReference)
					reference(node.typeName, origin, owner)
				else if (node.kind === SyntaxKind.ExpressionWithTypeArguments)
					reference(node.expression, origin, owner)
				else if (node.kind === SyntaxKind.TypeQuery)
					reference(node.exprName, origin, owner)
				else if (node.kind === SyntaxKind.ImportType)
					reference(node.qualifier ?? node.argument.literal, origin, owner)
				node.forEachChild((child) => {
					visit(child, origin, owner)
				})
			}
			for (const { file, name } of entries) {
				const symbol = checker.getSymbolAtLocation(program.getSourceFile(file))
				if (symbol)
					for (const child of checker.getExportsOfModule(symbol))
						inspect(child, `${name}.${child.name}`, packageName(name))
			}
			return [...missing.values()].sort()
		} finally {
			snapshot.dispose()
		}
	} finally {
		api.close()
	}
}

export function declarationProject(root) {
	const packages = publicPackages(root)
	const entries = packages.flatMap(({ directory, manifest }) =>
		Object.entries(manifest.publishConfig?.exports ?? manifest.exports).flatMap(
			([path, entry]) => {
				if (entry === null || path === "./package.json") return []
				const output = leaves(entry).find((file) =>
					/\.[cm]?[jt]sx?$/.test(file),
				)
				if (!output || output.includes("*") || path.includes("*"))
					throw new Error(
						`Unsupported declaration entry: ${manifest.name}${path}`,
					)
				return [
					{
						name: manifest.name + (path === "." ? "" : path.slice(1)),
						root: join(directory, ".cache/types"),
						file: resolve(
							directory,
							declarationPath(output.replace("./dist/", "./.cache/types/")),
						),
					},
				]
			},
		),
	)
	const directory = join(root, ".cache/public-api")
	mkdirSync(directory, { recursive: true })
	const config = join(directory, "tsconfig.json")
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				module: "esnext",
				moduleResolution: "bundler",
				target: "esnext",
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				paths: Object.fromEntries(
					entries.map(({ name, file }) => [name, [file]]),
				),
			},
			files: [...entries.map(({ file }) => file), ...dependencyFiles(packages)],
		}),
	)
	return { config, entries }
}

export function checkWorkspace(root) {
	const { config, entries } = declarationProject(root)
	return forgottenExports(config, entries)
}
