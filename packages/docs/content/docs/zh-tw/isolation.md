---
title: 領域與隔離
description: 讓外掛樹的某個分支擁有自己的服務和事件。
---

領域（realm）決定 fork 能看到哪些服務和事件。需要並排執行彼此獨立的實例時，可以使用領域，例如為每個租戶提供一組獨立的服務。如果只想修改某項設定，請參閱
[Intercept](../intercepts/)。

`Graft.plugin` 的 `isolate` 選項對該 fork 及其所有後代生效。

領域是一個行程內的**可見性**邊界：它決定 fork 能看到什麼，而不決定程式碼在哪裡執行。要把外掛的程式碼移到子行程、worker 或另一台機器上，請使用
[Remote](../remote/overview/)，它劃出的是**執行**邊界。兩者都不限制外掛程式碼能做什麼；如需權限邊界，請把 Remote 的 runner 放進容器或虛擬機器。

## 領域

每個服務鍵和事件都歸屬於一個**領域（realm）**。預設情況下，整個應用程式只有一個領域：無論在哪裡發布服務，所有外掛都能看到；事件也會傳遞給所有處理函式。

`isolate` 選項可以針對指定的鍵，為一個 fork 及其所有後代建立獨立的領域：

```ts
const tenants = Plugin.make({
	name: "tenants",
	apply: () =>
		Effect.gen(function* () {
			yield* Graft.plugin(tenant, { name: "a" }, { isolate: [Database] })
			yield* Graft.plugin(tenant, { name: "b" }, { isolate: [Database] })
		}),
})
```

在這個例子中，每個 `tenant` fork 都可以發布自己的 `Database`。

- 每個 fork 內的外掛只會看到該 fork 自己的 `Database`。
- 在外部發布的 `Database` 對內部不可見，反之亦然。
- 未隔離的鍵仍然照常共用。

`isolate` 接受任何帶有 `key` 的物件：可以是 `Database`
這類服務鍵，也可以是[事件](../events/)。

### 共用領域

使用標籤可以讓多個 fork 加入同一個共用領域，而不是各自使用私有領域：

```ts
const staging = Effect.gen(function* () {
	yield* Graft.plugin(api, undefined, { isolate: [[Database, "staging"]] })
	yield* Graft.plugin(worker, undefined, { isolate: [[Database, "staging"]] })
})
```

無論 `api` 和 `worker` 位於樹的哪個位置，它們都共用 `staging` 領域的
`Database`，看不到其他領域發布的 `Database`。

標籤的規則：

- 標籤與服務鍵或事件鍵是身分的兩個獨立部分。Graft 把它們各自當作完整的字串處理，包括內嵌的 NUL 字元。
- 以 `#` 或 `@` 開頭的標籤不會指向私有領域。
- 空標籤代表一個共用領域，這個領域與預設的根領域不同。

### 環境後備與繼承

領域隔離的是已發布的服務，不隔離建構 `Graft.layer` 時環境中的服務。

| 問題                                                           | 答案                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 領域中沒有某個注入鍵的 provision 時會怎樣？                    | 消費者可以使用環境中的值。                                                                                  |
| 在領域 A 發布服務，會讓領域 B 中使用環境值的消費者重新啟動嗎？ | 不會。撤回服務同樣不會。                                                                                    |
| 父外掛的 provision 會透過 Effect context 傳給子外掛嗎？        | 不會。每個子外掛必須透過自己的 `inject` 相依項目，在自己的領域中取得 provision。                            |
| 來自環境的值仍然可用嗎？                                       | 可用。如果父外掛的 provision 遮蔽了根環境中的值，子外掛可以重新使用該環境後備，這個規則也適用於多代子外掛。 |
