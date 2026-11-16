# @graftland/graft

[English](https://github.com/graftland/graft/blob/main/packages/core/README.md)
|
[简体中文](https://github.com/graftland/graft/blob/main/packages/core/README.zh-CN.md)
| 繁體中文

在應用程式執行期間掛載和卸載 Effect 的 Layer。

```sh
npm install effect @graftland/graft
```

`effect` 是 peer 相依項目，版本約束為 `4.1.*`。支援的 Node.js 最低版本是 22.19。

```ts
import { Context, Effect, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Region extends Context.Service<Region, string>()("app/Region") {}

const region = Layer.effect(Region, Effect.succeed("eu"))

export const program = Effect.gen(function* () {
	const mount = yield* Graft.mount(region, { name: "region" })
	yield* mount.await
})
```

## 它做什麼

- `Graft.mount` 在 `requires`
  可用期間建置一個 Layer，發布它的服務，並在某個相依項目消失時拆除它。
- `Graft.publish` 把一個值放進圖裡；`set` 會重建需要它的一切。
- `Graft.watch`、`await`、`use` 和 `whileAvailable` 在服務來來去去時讀取它們。
- `Graft.fork` 啟動一個歸掛載所有的背景 fiber。它的失敗帶著完整的 `Cause`
  使掛載失敗；純中斷不會。
- `Graft.mounts` 和 `Graft.logs` 展示掛載樹和收集到的日誌。

每個掛載擁有一個
`Scope`，所以拆除時消費者先在提供者之前停止，然後才釋放資源。`Mount.CleanupError`
保留每個失敗原因。

## 入口

| 入口        | 內容                                   |
| ----------- | -------------------------------------- |
| `.`         | `Graft`、`Mount` 與 `Release`。        |
| `./rpc`     | 透過任意 `effect/rpc` 協定的遠端服務。 |
| `./node`    | Node.js 的子行程和 worker 協定。       |
| `./testing` | 供測試使用的記憶體協定。               |

## 文件

- [快速開始](https://graftland.github.io/graft/zh-tw/quickstart/)
- [掛載](https://graftland.github.io/graft/zh-tw/mounting/)
- [發布](https://graftland.github.io/graft/zh-tw/publications/)
- [生命週期](https://graftland.github.io/graft/zh-tw/lifecycle/)
- [遠端服務](https://graftland.github.io/graft/zh-tw/remote/)

屬於 [Graft](https://github.com/graftland/graft)。基於
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE) 授權。
