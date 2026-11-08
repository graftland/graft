# @graftland/plugin-http-api

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

把 Effect
HttpApi 路由组作为普通 Graft 插件提供服务。可选的组合插件不影响路由运行；OpenAPI 和文档界面跟随实时贡献更新。

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

从 `@graftland/plugin-http-api/HttpApis` 导入 `HttpApis.serve`，传入普通
`HttpApiBuilder.group` 层。Scalar 和 Swagger 是独立插件；第三方界面注入
`HttpApis.Document`。

参见 [HTTP API 指南](https://docs.graft.land/zh-cn/http-api/)和
[http-gateway 示例](../../samples/http-gateway)。
