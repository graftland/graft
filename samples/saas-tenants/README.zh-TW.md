# SaaS 租戶

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文

一個筆記服務在同一個行程中代管免費方案的 Acorn 和專業方案的 Northstar。每個工作區執行相同的
`storage` 和 `notes`
外掛，它們的寫法就好像只有一個租戶。工作區加入和離開時，其他工作區繼續提供服務。

## 問題

多租戶通常會滲透到每一層。要麼每個租戶一個行程，要麼在每次呼叫中傳遞
`tenantId`，讓儲存、配額檢查和日誌選中正確的租戶。要在執行時期接入租戶，必須手工建構它的服務。要讓租戶退出，必須依正確的順序找到並停止屬於它的一切，同時不打擾其他任何人。

## Graft 的做法

`src/hosting.ts` 為每個工作區載入一次相同的 `tenant` 外掛：

```ts
Graft.plugin(
	tenant,
	{ file: config.file },
	{
		isolate: [NoteStore],
		intercept: [
			Graft.intercept(Tenant, () => config.id),
			Graft.intercept(Plan, () => config.plan),
			Graft.intercept(References.CurrentLogAnnotations, (outer) => ({
				...outer,
				tenant: config.id,
			})),
		],
	},
)
```

- **隔離沿著樹進行。** 每個租戶的 `storage` 把 `NoteStore`
  發布到一個私有的 realm 中，所以它的 `notes`
  外掛只能看到那個儲存。兩個租戶都可以儲存 ID 為 `launch`
  的筆記，各自讀回的都是自己的那一則。`storage` 和 `notes`
  中沒有任何地方接收租戶 ID。
- **消費者等待它們的提供者。** `notes` 先載入，在其租戶的儲存發布之前一直處於
  `Pending`。然後它自動啟動。
- **一個共用服務，依租戶設定。** `Quota` 只在根部發布一次。它在被呼叫時讀取
  `Plan`
  參照。事件處理器在註冊它的外掛的上下文中執行。因此同一個服務允許 Acorn 儲存一則筆記，允許 Northstar 儲存三則。租戶的外掛輸出的每一行日誌都帶有
  `tenant: <id>`。
- **讓租戶退出只需一次呼叫。** 對租戶呼叫 `fork.dispose`
  會移除它的請求處理器，停止
  `notes`，然後才排清並關閉它的儲存。另一個租戶保留它的 fork、處理器和資料。

請求邊界仍然負責選擇租戶。`request(id, command)` 用 `Event.filtered`
分派，與處理器的 `Tenant`
參照相符。它代表一個經過驗證的 API 轉接器。租戶 ID 只存在於那裡和佈建過程中。Realm 隔離的是已發布的服務，不隔離檔案系統存取，也不隔離根環境中的服務。

## 執行

在儲存庫根目錄執行：

```sh
devenv shell -- pnpm build
devenv shell -- pnpm --filter @graftland/sample-saas-tenants start
```

執行從本套件中一個空的 `data/`
目錄開始，並在其中為每個租戶留下一個 JSON 檔案。輸出中值得注意的內容：

- 第 1 步：`Notes Pending: waiting for this tenant's NoteStore`，然後是
  `Storage opened` 和 `Notes ready`，每則都帶有 `tenant: acorn`。
- 第 2 步：Northstar 讀取 `launch` 得到 `Missing`，儘管 Acorn 有一則。
- 第 3 步：第二則筆記對 Acorn 被拒絕（`limit: 1`），對 Northstar 則被儲存（`limit: 3`），兩者用的是同一個配額服務。
- 第 4 步：Acorn 的 `Notes stopped` 出現在它的 `Storage flushed and closed`
  之前。此後 Acorn 沒有處理器了，而 Northstar 仍然回傳它自己的筆記。

儲存把筆記保存在記憶體中，並在關閉時寫入。它只是一個替身，不是能抵禦當機的資料庫。

`devenv shell -- pnpm --filter @graftland/sample-saas-tenants test`
會檢查上述每一項說法。它使用記憶體內的檔案系統。

## 檔案

| 檔案                        | 說明                                                           |
| --------------------------- | -------------------------------------------------------------- |
| `src/services.ts`           | 筆記 schema、服務鍵、`Plan` 和 `Tenant` 參照、請求和回應型別。 |
| `src/storage.ts`            | 租戶的筆記，從它的 JSON 檔案載入，並排清寫回該檔案。           |
| `src/notes.ts`              | 筆記操作和請求處理器。                                         |
| `src/quota.ts`              | 共用的配額服務，讀取呼叫方的 `Plan`。                          |
| `src/tenant.ts`             | 每個租戶執行的外掛。                                           |
| `src/hosting.ts`            | 使用 `isolate` 和 `intercept` 接入租戶，以及請求路由。         |
| `src/lifecycle.ts`          | 等待 fork 變為 `Active`。                                      |
| `src/main.ts`               | 腳本化的執行。                                                 |
| `test/saas-tenants.test.ts` | 上述行為的測試。                                               |
