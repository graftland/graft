---
title: 失敗與重試
description: 讀取失敗掛載的 Cause，選擇重試排程，並弄清各個錯誤的含義。
---

失敗的掛載不會消失。它進入 `Failed`，保留完整的
`Cause`，等待一次變化或它的重試排程。

## 讀取失敗

`mount.await` 以掛載的錯誤失敗；`mount.state` 送出帶有同一個 `Cause` 的 `Failed`
狀態。

```ts import.meta.vitest name="failures-retry: a failed build keeps its cause"
import { Context, Effect, Exit, Layer } from "effect"

import { Graft } from "@graftland/graft"

class Greeting extends Context.Service<Greeting, string>()("app/Greeting") {}

const failed = Layer.effect(Greeting, Effect.fail("no greeting"))

const failure = await Effect.runPromise(
	Effect.gen(function* () {
		const mount = yield* Graft.mount(failed, { name: "greeting" })
		return yield* Effect.exit(mount.await)
	}).pipe(Effect.scoped, Effect.provide(Graft.layer)),
)
Exit.isFailure(failure) // => true
```

這個 `Cause` 保留型別化錯誤、defect 和中斷原因。清理失敗也會併入同一個
`Cause`，所以 Layer 拆除期間失敗的終結器不會遺失。

## 清理缺陷會把啟動失敗改判為缺陷

當 Layer 建構失敗，且同一次建構的清理中有終結器以 defect 結束時，Effect 會把建構的型別化失敗改判為 defect（與
`Effect.scoped` 一致）。因此在掛載的 `Failed` cause 中，啟動錯誤以 `Die`
出現，`catchTag` 無法匹配。

| 情況                               | 啟動錯誤在 cause 中的形態       |
| ---------------------------------- | ------------------------------- |
| 建構失敗，清理正常                 | `Fail`，保留 Layer 的型別化錯誤 |
| 建構失敗，且有終結器以 defect 結束 | `Die`，`catchTag` 無法匹配      |

若需要保留型別化的啟動錯誤，終結器應以型別化失敗或不失敗的方式結束。

## 重試失敗的掛載

傳入一個 Effect `Schedule` 作為 `retry`，在建置失敗後重建：

```ts
import { Context, Effect, Layer, Schedule } from "effect"

import { Graft } from "@graftland/graft"

class Connection extends Context.Service<Connection, string>()(
	"app/Connection",
) {}

declare const connect: Effect.Effect<string, Error>

export const connection = Layer.effect(
	Connection,
	connect.pipe(Effect.retry(Schedule.exponential("1 second"))),
)

export const program = Graft.mount(connection, {
	name: "connection",
	retry: Schedule.exponential("1 second"),
})
```

| 情況                   | 發生什麼                                          |
| ---------------------- | ------------------------------------------------- |
| 建置失敗，設定了排程   | 掛載保持 `Failed`，然後依排程重試。               |
| 建置失敗，沒有設定排程 | 掛載只嘗試一次，保持 `Failed`，等待一次變化。     |
| 排程要求零延遲         | 每次下一次重試至少等待 1 毫秒，這次等待可被中斷。 |
| 排程要求正延遲         | 掛載正好等待該延遲，不額外增加。                  |
| 等待期間掛載被卸載     | 這次等待被取消。                                  |
| 相依項目或掛載規格變化 | 取消目前的重試，清理完成後開始新的嘗試。          |
| 什麼都沒變             | 排程在兩次嘗試之間保留自己的步進和預算。          |
| 發布衝突阻塞了掛載     | Graft 等待圖發生變化，而不是反覆重試進同一個環。  |

再次失敗的重試把新的失敗與之前的 `Cause`
合併。掛載在整個過程中都可以觀察，也可以重新啟動。

`mount.await` 不會等重試成功。它在第一次 `Failed` 時結束，並以該 `Cause`
失敗；`retry` 排程在背景繼續。用 `state` 觀察後續的嘗試。

## 錯誤名稱

| 錯誤                         | 何時產生                                                   | 怎麼辦                                   |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `Graft.ServiceConflict`      | 領域裡已經有服務提供者，或者發布會導致重建它自己的提供者。 | 讀取 `reason`；見下文。                  |
| `Graft.ServiceWithdrawn`     | `Graft.use` 使用的值在執行期間被撤回。                     | 重試這項工作，或用 `watch` 等待該值。    |
| `Mount.CleanupError`         | `unmount` 或自動關閉 scope 時，釋放資源遇到失敗。          | 讀取 `cause`；它保留原始失敗和 defect。  |
| `Release.ReleaseInterrupted` | 外層釋放正在被取消時，終結器自己中斷了。                   | 當作 defect 處理；`cause` 保留那次中斷。 |

### ServiceConflict

| `reason`          | 含義                               |
| ----------------- | ---------------------------------- |
| _（無）_          | 另一個掛載或發布已經提供了這個鍵。 |
| `SelfDependency`  | 發布會導致直接重建提供者自己。     |
| `DependencyCycle` | 同樣的情形，但經過其他掛載。       |
| `Invalidated`     | 相依變化已經使提供者失效。         |

這個錯誤還帶有服務名、它的領域，以及嘗試發布的掛載 ID。

## 失敗落在哪裡

| 來源                        | 結果                                     |
| --------------------------- | ---------------------------------------- |
| 建置 Layer                  | `Failed`，帶有建置的 `Cause`。           |
| `Graft.fork` 的 fiber 失敗  | `Failed`，帶有該 fiber 的 `Cause`。      |
| 資源終結器失敗              | 併入執行它的那次拆除的 `Cause`。         |
| 裸 `Effect.forkScoped` 失敗 | 透過該 fiber 的 scope 回報，不交給掛載。 |

失敗會啟動正常的[拆除順序](../lifecycle/#拆除順序)。健康的背景 fiber 繼續為消費者服務，直到它們的租約被釋放。
