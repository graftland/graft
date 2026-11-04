import { rmSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { resolve, join } from "node:path"
import { createStarlightTypeDocPlugin } from "starlight-typedoc"
import { publicPackages } from "../../scripts/public-api.mjs"
import { referenceEntries, verifyReference } from "../../scripts/reference.mjs"

const labels = {
	Overview: ["概览", "概覽"],
	Classes: ["类", "類別"],
	Enumerations: ["枚举", "列舉"],
	Functions: ["函数", "函式"],
	Interfaces: ["接口", "介面"],
	Namespaces: ["命名空间", "命名空間"],
	References: ["重导出", "重新匯出"],
	"Type Aliases": ["类型别名", "型別別名"],
	Variables: ["值", "值"],
}

function translateSidebar(items) {
	return items.map((item) => {
		if (typeof item !== "object") return item
		const translation = labels[item.label]
		return {
			...item,
			...(translation && {
				translations: { "zh-CN": translation[0], "zh-TW": translation[1] },
			}),
			...(item.items && { items: translateSidebar(item.items) }),
		}
	})
}

/** Build the navigation and documentation from the release entry inventory. */
function packageReferences() {
	const root = fileURLToPath(new URL("../../", import.meta.url))
	const packages = publicPackages(root).map(({ directory, manifest }) => {
		const [plugin, sidebar] = createStarlightTypeDocPlugin()
		const name = manifest.name.replace("@graftland/", "")
		return {
			sidebar,
			plugin: plugin({
				entryPoints: referenceEntries(root)
					.filter((entry) => entry.packageName === manifest.name)
					.map((entry) => {
						if (!entry.source)
							throw new Error(`Missing source export: ${entry.name}`)
						return resolve(directory, entry.source)
					}),
				tsconfig: fileURLToPath(
					new URL("./tsconfig.reference.json", import.meta.url),
				),
				output: `reference/${name}`,
				sidebar: { label: manifest.name, collapsed: true },
				typeDoc: {
					name: manifest.name,
					basePath: join(directory, "src"),
					alwaysCreateEntryPointModule: true,
					excludeInternal: true,
					excludePrivate: true,
					excludeProtected: true,
					excludeExternals: false,
					useCodeBlocks: true,
					formatWithPrettier: true,
					expandObjects: true,
					expandParameters: true,
					typeDeclarationVisibility: "verbose",
					classPropertiesFormat: "table",
					tableColumnSettings: { hideInherited: true, hideOverrides: true },
					parametersFormat: "table",
					typeDeclarationFormat: "table",
					readme: fileURLToPath(
						new URL("./reference-intro.md", import.meta.url),
					),
					plugin: [
						fileURLToPath(new URL("./typedoc-plugin.mjs", import.meta.url)),
					],
				},
			}),
		}
	})
	return packages
}

/** Defer filesystem access and generation until Starlight runs its setup hook. */
export function reference() {
	return {
		name: "graft-reference",
		hooks: {
			async "config:setup"(context) {
				if (context.command === "preview") return
				rmSync(new URL("./src/content/docs/reference/", import.meta.url), {
					recursive: true,
					force: true,
				})
				const packages = packageReferences()
				let sidebar = context.config.sidebar.map((group) =>
					group.label === "Reference"
						? {
								...group,
								items: [
									...packages.map(({ sidebar }) => sidebar),
									...group.items,
								],
							}
						: group,
				)
				context.updateConfig({ sidebar })
				for (const { plugin } of packages) {
					await plugin.hooks["config:setup"]({
						...context,
						config: { ...context.config, sidebar },
						updateConfig(update) {
							if (update.sidebar) sidebar = update.sidebar
							context.updateConfig(update)
						},
					})
				}
				context.updateConfig({ sidebar: translateSidebar(sidebar) })
				const root = fileURLToPath(new URL("../../", import.meta.url))
				context.logger.info(
					`Verified all ${verifyReference(root)} public entries with TypeScript 7.`,
				)
			},
		},
	}
}
