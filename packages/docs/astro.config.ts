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
				"Horticultural Effect Systems. Effect layers that mount and unmount while the application runs.",
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
					items: ["index", "quickstart", "concepts"],
				},
				{
					label: "Build",
					translations: { "zh-CN": "构建", "zh-TW": "建構" },
					items: ["mounting", "publications", "availability"],
				},
				{
					label: "Structure",
					translations: { "zh-CN": "组织与变更", "zh-TW": "組織與變更" },
					items: ["lifecycle", "failures-retry", "isolation", "intercepts"],
				},
				{
					label: "Run",
					translations: { "zh-CN": "运行", "zh-TW": "執行" },
					items: ["background-fibers", "observability"],
				},
				{
					label: "Remote",
					translations: { "zh-CN": "Remote", "zh-TW": "Remote" },
					items: ["remote", "node", "testing"],
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
