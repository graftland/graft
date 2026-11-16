<img src="packages/docs/src/assets/graft-mark.svg" alt="" width="72" align="right">

# Graft

**園藝學 Effect 系統。** _放心修剪。_

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

Layer 不由啟動時決定。它們是長出來的。

Graft 讓 Effect 的 `Layer`
變成動態的。掛載一個 Layer，Graft 會在它需要的一切都可用時建置它，發布它提供的服務，並在某個相依項目消失時先把相依它的部分停掉，再拆除它。設定就是一個普通的發布值，修改它會讓相依它的一切重建。

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}
class Report extends Context.Service<Report, string>()("app/Report") {}

const report = Layer.effect(
	Report,
	Effect.map(Region, (region) => `Report for ${region}`),
)

export const program = Effect.gen(function* () {
	// A value from outside any layer. `set` rebuilds its consumers.
	const region = yield* Graft.publish(Region, "eu")

	// Built while Region is available, torn down and rebuilt when it changes.
	const mount = yield* Graft.mount(report, {
		name: "report",
		requires: [Region],
	})
	yield* mount.await

	yield* region.set("us")
})
```

## 為什麼選擇 Graft

- **可用性驅動圖。**
  掛載等待它需要的服務，全部到齊時建置，其中一個消失時停止。可選相依出現或消失時，掛載重建。
- **拆除跟隨歸屬。** 每個掛載擁有一個
  `Scope`，它啟動的每個 fiber 都有歸屬。消費者先於提供者停止，然後關閉資源，失敗保留完整的
  `Cause`。
- **服務來來去去時也能讀取。** `watch`、`await`、`use` 和 `whileAvailable`
  從普通 Effect 程式碼裡讀取圖，撤回會中斷工作，而不是留下過期的值。
- **遠端服務仍是服務。** 透過任意 `effect/rpc`
  協定提供一個服務，並在另一個行程或另一台機器上發布它。使用它的掛載無需改動。

Graft 只相依 `effect`；`@effect/platform-node` 是可選的，只有 `node`
入口需要它。在 Node.js 上執行 Graft 需要 22.19 或更高版本。開發本工作區需要 Node.js
22.22 或更高版本，它同時用於建置文件。

## 開始使用

```sh
npm install effect @graftland/graft
```

閱讀[文件](https://docs.graft.land/zh-tw/)。[快速開始](https://docs.graft.land/zh-tw/quickstart/)掛載第一個 Layer；[核心概念](https://docs.graft.land/zh-tw/concepts/)說明圖、掛載和發布。

## 一個套件

Graft 只發布 `@graftland/graft`。

| 入口            | 內容                             |
| --------------- | -------------------------------- |
| `graft`         | `Graft`、`Mount` 與 `Release`。  |
| `graft/rpc`     | 透過 `effect/rpc` 的遠端服務。   |
| `graft/node`    | Node.js 的子行程和 worker 協定。 |
| `graft/testing` | 供測試使用的記憶體協定。         |

## 舊套件

從 0.7.0 起，Graft 是一個動態 Layer 程式庫。之前版本的 API 已移除，且不相容。

下列套件已不再開發，不再獲得更新：

| 套件                           | 最後一個版本 | 改用                             |
| ------------------------------ | ------------ | -------------------------------- |
| `@graftland/loader`            | `0.6.0`      | 在自己的程式裡用 `Graft.mount`。 |
| `@graftland/hmr`               | `0.5.0`      | 無；Graft 不再重載模組。         |
| `@graftland/cli`               | `0.6.0`      | 無；沒有命令，也沒有設定檔。     |
| `@graftland/create`            | `0.6.0`      | 無。                             |
| `@graftland/package-manager`   | `0.6.0`      | 無。                             |
| `@graftland/plugin-remote`     | `0.6.0`      | `graft/rpc` 入口。               |
| `@graftland/plugin-http`       | `0.5.0`      | 無。                             |
| `@graftland/plugin-http-api`   | `0.5.0`      | 無。                             |
| `@graftland/plugin-mcp-server` | `0.5.0`      | 無。                             |
| `@graftland/plugin-otlp`       | `0.5.0`      | 無。                             |
| `@graftland/plugin-release`    | 未發佈       | 無。                             |

`@graftland/plugin-release`
從未發佈，沒有對象可標記。在 npm 上標記舊套件為棄用是選用的獨立決定。

## 參與貢獻

命令在專案的 [devenv](https://devenv.sh) shell 中執行：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
```

檢查項目、發布流程和文件站見[發佈](https://docs.graft.land/zh-tw/releases/)。

## 授權

[Apache 2.0](LICENSE)
