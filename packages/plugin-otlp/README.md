# @graftland/plugin-otlp

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

Export a subtree's spans with an ordinary Graft exporter plugin. The host loads
`plugins` in a private exporter realm; the built-in
`@graftland/plugin-otlp/http` sends OTLP/HTTP using the injected `HttpClient`.

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

| Field                     | Meaning                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `url`                     | Required OTLP/HTTP traces endpoint.                                                            |
| `serviceName`             | Required `service.name` resource attribute.                                                    |
| `resource.serviceVersion` | Service version; defaults to an empty string (no version attribute).                           |
| `resource.attributes`     | Additional JSON resource attributes; defaults to `{}`.                                         |
| `headers`                 | Redacted HTTP headers; defaults to `{}`. Supply credentials with `!env`.                       |
| `serialization`           | `json` (default) or `protobuf`.                                                                |
| `compression`             | `none` (default) or `gzip` (Effect compresses bodies of at least 1 KB).                        |
| `exportInterval`          | Milliseconds between exports; defaults to `5000`.                                              |
| `maxBatchSize`            | Positive integer; defaults to `1000`.                                                          |
| `shutdownTimeout`         | Milliseconds allowed for a shutdown flush; defaults to `3000`.                                 |
| `exporter`                | Alternative `{ name, config }` for a third-party exporter; replaces all HTTP shorthand fields. |
| `plugins`                 | Entries to load and trace, as in `graft.yml`.                                                  |

Numeric options also accept strings from `!env`. HTTP shorthand fields compile
to `exporter: { name: "@graftland/plugin-otlp/http", config: … }`.

## Custom exporters

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

Implementations publish the stable tracer service from
`@graftland/plugin-otlp/Exporter`, whose key is
`@graftland/plugin-otlp/Exporter`. Use `@graftland/plugin-otlp/Testing` to check
publication, update identity, and flush on close. Built-ins and third parties
use the same public APIs and resolver.

| Change                                                 | Behavior                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP settings or compatible `exporter.config` updates  | The subtree keeps running. HTTP spans already started keep their old exporter, which flushes and closes when they end. Draining waits at most its `shutdownTimeout`; Effect then allows a separate `shutdownTimeout` for flushing (at most twice the timeout in total). |
| `plugins`                                              | Reconciles entries; unchanged entries keep their activations.                                                                                                                                                                                                           |
| Exporter name, or moving entries into/out of `plugins` | Restarts the subtree or moved entries: their provider, parent, or intercept changes.                                                                                                                                                                                    |
| Exporter failure                                       | The subtree waits for `Exporter` and resumes when the exporter’s own retry succeeds; no config change is needed.                                                                                                                                                        |
| Unload                                                 | Stops the subtree, then flushes and closes all remaining exporters concurrently.                                                                                                                                                                                        |

Effect has one tracer per subtree and no fan-out combinator; nested hosts
override outer tracing. This package ships only the HTTP trace exporter. Third
parties own other transports, enrichment, and vendor integrations. This package
provides no log or metrics export; third parties may implement them.

## Documentation

- [Logs and tracing](https://docs.graft.land/best-practices/observability/)

Part of [Graft](https://github.com/graftland/graft). Licensed under
[Apache 2.0](https://github.com/graftland/graft/blob/main/LICENSE).
