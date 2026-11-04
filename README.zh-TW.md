<img src="packages/docs/src/assets/graft-mark.svg" alt="" width="72" align="right">

# Graft

**園藝學 Effect 系統。** _放心修剪。_

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

軟體不是造出來的，是長出來的。

Graft 是以 [Effect](https://effect.website)
打造的外掛框架。應用程式是一棵外掛樹：每個外掛嫁接在一個 scope 上，從周圍汲取服務，也發布自己的服務。你可以在行程持續執行的同時載入、重新設定、取代和卸載任意一枝。剪掉哪裡，樹的其餘部分都照常生長。

```ts
import { Graft, Plugin } from "@graftland/graft"
import { Context, Effect, Schema } from "effect"

class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => Effect.Effect<void> }
>()("app/Greeter") {}

// Publishes a Greeter while it is loaded.
const greeter = Plugin.make({
	name: "greeter",
	config: Schema.Struct({ greeting: Schema.String }),
	apply: ({ greeting }) =>
		Graft.provide(Greeter, {
			greet: (name) => Effect.log(`${greeting}, ${name}!`),
		}),
})

// Starts once a Greeter exists, and stops before it goes away.
const hello = Plugin.make({
	name: "hello",
	inject: [Greeter],
	apply: () => Effect.flatMap(Greeter, (greeter) => greeter.greet("world")),
})
```

## 為什麼選擇 Graft

- **砧木。** 服務是 Effect 的 `Context` 鍵，由 `Layer` 或其他外掛提供。外掛在
  `inject` 中宣告相依，由編譯器檢查。
- **修剪。** 每個外掛都在自己的 `Scope`
  中執行，它啟動的每個 fiber 都有歸屬。外掛消失時，相依於它的外掛先停止，然後執行它的 finalizer。不留殘枝，失敗也保留完整的
  `Cause`。
- **高接換種。** 不砍樹，只換品種。`graft start --watch`
  只重新匯入受變更影響的部分，並在一次交易中取代相關外掛。新程式碼失敗時，舊外掛繼續執行。

在 Node.js 上執行 Graft 需要 22.19 或更新版本。開發本工作區需要 Node.js
22.22 或更新版本，其中包括用 Astro 建置文件。

## 快速開始

```sh
npx @graftland/cli create my-app --install
cd my-app
npx graft start --watch
```

閱讀[文件](https://graftland.github.io/graft/zh-tw/)。

Graft 的外掛模型借鑑自
[cordis](https://github.com/cordiverse/cordis)。cordis 在時空中組合，Graft 只照料自己的園子。請看
[cordis 的概念如何對應到 Graft](https://graftland.github.io/graft/zh-tw/cordis/)。

## 範例

[`samples/`](samples)
以五個簡短的編號範例開頭。每個範例講一個概念，從第一個外掛到透過 `graft.yml`
執行。

之後是更大的應用程式，展示 Graft 的用途：

- 由外掛組成的聊天機器人
- 在負載下替換定價引擎和資料庫的結帳服務
- 由 `graft.yml` 驅動的 HTTP 閘道
- 多租戶服務
- 能在不穩定的上游下繼續運作的行情資料管線

## 套件

| 套件                                                     | 作用                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| [`@graftland/graft`](packages/core)                      | 以 Effect 打造的外掛框架：外掛、fork、服務、隔離、事件和日誌。 |
| [`@graftland/loader`](packages/loader)                   | 從條目清單或 YAML 設定檔載入外掛。                             |
| [`@graftland/hmr`](packages/hmr)                         | 在 Node.js 上重載外掛模組，不需重新啟動行程。                  |
| [`@graftland/cli`](packages/cli)                         | `graft` 命令：`start`、`create`、`add` 和 `remove`。           |
| [`@graftland/create`](packages/create)                   | 產生新的 Graft 專案。`graft create` 使用它。                   |
| [`@graftland/package-manager`](packages/package-manager) | 用 npm、pnpm 或 Yarn 安裝相依套件，失敗時還原。                |

所有套件以相同版本一起發布。它們都需要 `effect` 4.1.x。

## 參與貢獻

命令在專案的 [devenv](https://devenv.sh) shell 中執行：

```sh
devenv shell -- pnpm install
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
```

檢查項目、發布流程和文件網站請見[發布](https://graftland.github.io/graft/zh-tw/releases/)。

## 授權

[Apache 2.0](LICENSE)
