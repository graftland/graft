# @graftland/plugin-otlp

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md)

用普通 Graft exporter 插件导出一棵子树的 span。宿主在独立的 exporter
realm 中加载 `plugins`；内置的 `@graftland/plugin-otlp/http` 通过注入的
`HttpClient` 发送 OTLP/HTTP。

```yaml
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    url: !env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    serviceName: shop
    headers:
      authorization: !env OTEL_AUTHORIZATION
    plugins:
      - id: server
        name: ./src/server.ts
```

| 字段                      | 含义                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `url`                     | 必填的 OTLP/HTTP traces 端点。                                  |
| `serviceName`             | 必填的 `service.name` 资源属性。                                |
| `resource.serviceVersion` | 服务版本；默认为空字符串（不添加版本属性）。                    |
| `resource.attributes`     | 额外的 JSON 资源属性；默认为 `{}`。                             |
| `headers`                 | 以 Redacted 保存的 HTTP 头；默认为 `{}`。凭据通过 `!env` 传入。 |
| `serialization`           | `json`（默认）或 `protobuf`。                                   |
| `compression`             | `none`（默认）或 `gzip`（Effect 压缩至少 1 KB 的请求体）。      |
| `exportInterval`          | 导出间隔，单位毫秒；默认为 `5000`。                             |
| `maxBatchSize`            | 正整数；默认为 `1000`。                                         |
| `shutdownTimeout`         | 关闭时刷新所允许的毫秒数；默认为 `3000`。                       |
| `exporter`                | 第三方 exporter 的 `{ name, config }`，替代全部 HTTP 简写字段。 |
| `plugins`                 | 要加载并追踪的配置项，写法与 `graft.yml` 相同。                 |

数值选项也接受 `!env` 提供的字符串。HTTP 简写字段等价于
`exporter: { name: "@graftland/plugin-otlp/http", config: … }`。

## 自定义 exporter

```yaml
- id: traced
  name: "@graftland/plugin-otlp"
  config:
    exporter:
      name: graft-plugin-custom-traces
      config:
        destination: !env TRACE_DESTINATION
    plugins:
      - id: server
        name: ./src/server.ts
```

实现通过 `@graftland/plugin-otlp/Exporter` 发布稳定的 tracer 服务，其 key 为
`@graftland/plugin-otlp/Exporter`。用 `@graftland/plugin-otlp/Testing`
检查服务发布、更新时的对象身份和关闭时的刷新。内置与第三方实现使用相同的公开 API 和解析器。

| 修改                                         | 行为                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 设置或兼容的 `exporter.config` 更新     | 子树继续运行。已开始的 HTTP span 留在旧 exporter；这些 span 结束后刷新并关闭旧 exporter。等待最长为旧配置的 `shutdownTimeout`；Effect 随后为刷新单独提供一个 `shutdownTimeout` 时限（总计最长为两倍时限）。 |
| `plugins`                                    | 协调配置项；未变化的配置项保留 activation。                                                                                                                                                                 |
| Exporter 名称，或将配置项移入/移出 `plugins` | 重启子树或移动的配置项，因为 provider、父级或 intercept 改变了。                                                                                                                                            |
| Exporter 失败                                | 子树等待 `Exporter` 服务；exporter 自身重试成功后，子树恢复运行，无需修改配置。                                                                                                                             |
| 卸载                                         | 先停止子树，再并发刷新并关闭所有剩余 exporter。                                                                                                                                                             |

Effect 每棵子树只有一个 tracer，没有 fan-out 组合器；嵌套宿主会覆盖外层追踪。本包只提供 HTTP
trace
exporter。其他传输、属性增强和厂商集成由第三方实现。本包不提供日志和指标导出；第三方可以实现这些功能。

## 文档

- [日志与追踪](https://graftland.github.io/graft/zh-cn/best-practices/observability/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
