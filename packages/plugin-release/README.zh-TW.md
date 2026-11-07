# @graftland/plugin-release

透過 Graft Change 提供不可變的受管應用程式發佈、設定規劃和回復。

Change 請求遭拒後停止前向執行，並按相反順序補償先前接受的項目。補償使用對應已接受 Change 產生的版本；衝突時保留後續已接受的 Change。觀察結果區分拒絕與已准入的 Change
id。每次分配都會重新解析保留的期望設定，包括復原和補償。

https://graftland.github.io/graft/zh-tw/application-releases/
