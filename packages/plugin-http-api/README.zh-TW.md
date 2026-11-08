# @graftland/plugin-http-api

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

將 Effect
HttpApi 路由群組作為普通 Graft 外掛提供服務。選用的組合外掛不影響路由執行；OpenAPI 與文件介面跟隨即時貢獻更新。

```yaml
- name: "@graftland/plugin-http/router"
- name: "@graftland/plugin-http"
  config: { port: 3000 }
- name: "@graftland/plugin-http-api"
  config:
    title: My API
    version: 1.0.0
    openapi: /openapi.json
- name: "@graftland/plugin-http-api/scalar"
  config: { path: /docs }
```

從 `@graftland/plugin-http-api/HttpApis` 匯入 `HttpApis.serve`，傳入普通
`HttpApiBuilder.group` 層。Scalar 與 Swagger 是獨立外掛；第三方介面注入
`HttpApis.Document`。

參閱 [HTTP API 指南](https://docs.graft.land/zh-tw/http-api/)與
[http-gateway 範例](../../samples/http-gateway)。
