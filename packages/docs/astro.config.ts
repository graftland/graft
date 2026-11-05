import starlight from "@astrojs/starlight"
import { defineConfig } from "astro/config"
import starlightLlmsTxt from "starlight-llms-txt"

import { referenceLinkCheck } from "./check-links.mjs"
import { reference } from "./reference.mjs"

// DOCS_URL is the public address of the site, such as
// https://graftland.github.io/graft/. Its path becomes the base of every page.
const url = new URL(process.env["DOCS_URL"] ?? "http://localhost:4321/")

export default defineConfig({
	site: url.origin,
	base: url.pathname,
	trailingSlash: "always",
	integrations: [
		referenceLinkCheck(url),
		starlight({
			title: "Graft",
			description:
				"Horticultural Effect Systems. A plugin framework for Effect: load, replace and unload plugins in a running process.",
			favicon: "/favicon.svg",
			logo: { src: "./src/assets/graft-mark.svg" },
			customCss: ["./src/styles/garden.css"],
			head: [
				{
					tag: "link",
					attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
				},
				{
					tag: "link",
					attrs: {
						rel: "preconnect",
						href: "https://fonts.gstatic.com",
						crossorigin: true,
					},
				},
				{
					tag: "link",
					attrs: {
						rel: "stylesheet",
						href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&display=swap",
					},
				},
			],
			// English pages are at the root; translations are in a folder named
			// after the locale.
			defaultLocale: "root",
			locales: {
				root: { label: "English", lang: "en" },
				"zh-cn": { label: "简体中文", lang: "zh-CN" },
				"zh-tw": { label: "繁體中文", lang: "zh-TW" },
			},
			// Starlight adds its Markdown features, such as the links next to
			// headings, only to pages in `src/content/docs`. Our pages are in
			// `content/docs`, so we name that folder here.
			markdown: { processedDirs: ["./content/docs"] },
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/graftland/graft",
				},
			],
			editLink: {
				baseUrl: "https://github.com/graftland/graft/edit/main/packages/docs/",
			},
			plugins: [reference(), starlightLlmsTxt({ projectName: "Graft" })],
			sidebar: [
				{
					label: "Start here",
					translations: { "zh-CN": "开始", "zh-TW": "開始" },
					items: ["index", "quickstart", "concepts", "cordis"],
				},
				{
					label: "Build plugins",
					translations: { "zh-CN": "编写插件", "zh-TW": "編寫插件" },
					items: ["plugins", "services", "events"],
				},
				{
					label: "Structure",
					translations: { "zh-CN": "组织与变更", "zh-TW": "組織與變更" },
					items: ["lifecycle", "isolation", "intercepts", "replace"],
				},
				{
					label: "Applications",
					translations: { "zh-CN": "应用", "zh-TW": "應用" },
					items: ["config-file", "cli", "hot-reload", "embedding"],
				},
				{
					label: "Remote",
					translations: { "zh-CN": "Remote", "zh-TW": "Remote" },
					items: [
						"remote/overview",
						"remote/hosts",
						"remote/runners",
						"remote/transport-auth",
						"remote/lifecycle",
						"remote/capabilities",
					],
				},
				{
					label: "API guides",
					translations: { "zh-CN": "API 使用说明", "zh-TW": "API 使用說明" },
					items: ["fork-handle", "loader-api", "hmr-api", "errors"],
				},
				{
					label: "Project",
					translations: { "zh-CN": "项目", "zh-TW": "專案" },
					items: ["releases"],
				},
				// Generated from the public entries at build time; always the last group.
				{
					label: "Reference",
					translations: { "zh-CN": "参考", "zh-TW": "參考" },
					items: [],
				},
			],
		}),
	],
})
