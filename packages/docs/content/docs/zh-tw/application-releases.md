---
title: 發佈成品
description: 建立不可變發佈目錄。
---

`@graftland/plugin-release`
從套件中繼資料建立內容定址的發佈目錄。它匯出儲存資料及驗證；部署使用[核心變更 API](../transitions/)。

## 建立

向 `build` 提供儲存目錄及來源檔案，回傳值識別不可變目錄。`metadataOnly`
避免匯入套件程式碼。應用批次、補償及持久變更復原屬於後續發佈階段。
