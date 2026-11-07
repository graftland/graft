# @graftland/plugin-http-api

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Serve Effect HttpApi groups as ordinary Graft plugins. Groups keep working
without the optional composer; OpenAPI and documentation UIs follow live
contributions.

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

Use `HttpApis.serve` from `@graftland/plugin-http-api/HttpApis` with ordinary
`HttpApiBuilder.group` layers. Scalar and Swagger are separate plugins;
third-party UIs inject `HttpApis.Document`.

See the [HTTP API guide](https://graftland.github.io/graft/http-api/) and
[http-gateway sample](../../samples/http-gateway).
