---
title: 記錄
description: 要求變更在執行、提交及成功之前，先取得已確認的記錄。
---

**記錄者**是執行單元中持有部署記錄角色的外掛。變更涉及記錄範圍內的實例時，核心在每個階段向記錄者傳送一筆記錄，並等待其確認。

- 意圖記錄確認之前，不執行任何生命週期操作。
- 提交決定確認之前，不啟用任何路由。
- 結論記錄確認之後，才回報 `Accepted`。
- 停止、終止及結束觀察從不等待記錄者。

## 宣告角色

記錄是部署資料。閉包中包含 `scope` 內實例的每個變更都須記錄，請求不能選擇略過。

```ts
import { Layer } from "effect"

import { Kernel } from "@graftland/graft"
import { Units } from "@graftland/plugin-remote"

declare const instances: Kernel.Deployment["instances"]

export const kernel = Kernel.layer({
	authority: "shop",
	maxUnits: 8,
	instances,
	recording: { recorder: "release", instance: "release", scope: ["checkout"] },
}).pipe(Layer.provide(Units.layer))
```

| 欄位         | 意義                                                      |
| ------------ | --------------------------------------------------------- |
| `recorder`   | 外掛註冊時使用的角色名稱。                                |
| `instance`   | 唯一可持有該角色的實例，角色由其所在的單元持有。          |
| `scope`      | 需要記錄的變更所涉及的實例。                              |
| `maxRecords` | 未確認與已預留記錄的上限，超出的新工作會被拒絕。預設 64。 |

## 執行記錄者

`@graftland/plugin-release/Recorder`
是一般的記錄者：它把每筆記錄存入所在單元的記憶體，然後確認。將它部署為
`instance`，輸入為 `{ recorder: "release" }`。第三方外掛透過同一個
`Recording.Recorder` 服務持有該角色，第一方沒有特殊通道。

```ts
import { Effect, Stream } from "effect"

import { Plugin } from "@graftland/graft"
import { Recording } from "@graftland/plugin-remote"

export default Plugin.make({
	name: "audit-recorder",
	inject: [Recording.Recorder],
	apply: Effect.fn(function* () {
		const recorder = yield* Recording.Recorder
		yield* recorder.records.pipe(
			Stream.runForEach((record) => recorder.acknowledge(record)),
			Effect.forkScoped,
		)
		yield* recorder.register("release")
	}),
})
```

| 規則     | 行為                                                                   |
| -------- | ---------------------------------------------------------------------- |
| 身分     | 單元的控制通道標明化身，外掛不能代替其他化身註冊或確認。               |
| 註冊     | 接受來自承載 `instance` 之單元的註冊；該單元成為目前單元後授權才生效。 |
| 確認     | 儲存之後再確認。重複確認會被忽略；內容、擁有者或化身不符則被拒絕。     |
| 重新連線 | 同一化身再次註冊時，核心重送其尚未確認的記錄。                         |
| 持久性   | 無。記錄在確認前只存於記錄者的記憶體及核心中。                         |

## 缺少記錄時

| 情形                       | 結果                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| 提交時沒有存活的記錄者     | 在配置變更 id 之前以 `RecordingUnavailable` 拒絕。                    |
| 未確認的記錄過多           | 以 `RecordingCapacity` 拒絕，不會淘汰任何記錄義務。                   |
| 記錄者不再確認或已結束     | 後續工作等待；預算照常耗盡，依一般的[結局規則](../transitions/)收尾。 |
| 只缺結論記錄               | 執行已經完成並維持原狀。不回報結局；取消也不改變任何事物。            |
| 記錄者帶著未確認的義務結束 | 新的化身不能確認這些義務，`status.recording.blocked` 維持為 `true`。  |
| 變更會替換記錄者所在的單元 | 若該變更需要記錄，或存在未確認的義務，以 `SelfReplacement` 拒絕。     |

`status.recording` 顯示目前關卡、未確認的記錄及其是否受阻。`kernel.recording` 與
[`client.recording`](../control/)
列出所有未確認的記錄，包括已結束記錄者的記錄。核心行程遺失時，這些記錄隨之遺失。
