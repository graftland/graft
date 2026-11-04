---
title: 传输与认证
description: 部署前，在这里选择传输和认证方式。
---

部署前，在这里选择传输和认证方式。本页列出支持的组合、何时出现 WARN，以及各自的边界。

## 选择传输与认证

| `connect` / runner listener    | 认证                           | 保证与 WARN                                                                                       |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `local: {}`                    | 不可写 `auth`                  | 独立进程，普通 OS 权限；无传输 WARN。                                                             |
| `worker: {}`                   | 不可写 `auth`                  | 与宿主同进程，只隔离执行，**不隔离权限**；无传输 WARN。                                           |
| `url: wss://…`                 | mtls、bearer、jwt、none        | 加密，验证服务器证书。none 在 runner 启动和每次连接时 WARN。                                      |
| `url: ws://…`                  | bearer、jwt、none              | 不加密。runner 启动、宿主连接时 WARN；使用 token 时明确提示凭证以明文传输。none 还会逐连接 WARN。 |
| `unix: …`                      | bearer、jwt、none              | 依赖文件权限，不读取对端凭证；无传输或认证 WARN。                                                 |
| `command: […]` / `stdio: true` | 不可显式写 `auth`，none 也不行 | 认证和加密由 SSH 等外部命令负责。                                                                 |

省略 auth 就是 none，runner 默认身份为
`anonymous`。网络 listener 会 WARN；所有调用者共享这个身份。mTLS 只支持 wss。ws 不写 cert/key，wss 必须同时写两者。WebSocket 路径为
`/graft`，子协议为 `graft-remote.v1`；没有其他 HTTP 端点或健康检查。

- **Bearer**：宿主 `auth: { bearer: { token: "value" } }`；runner
  `auth: { bearer: { tokens: "./tokens.json" } }`。文件为 SHA-256 十六进制摘要到身份的映射：`{ "<sha256 hex>": "billing" }`，不保存明文 token。
- **JWT**：宿主 `auth: { jwt: { token: { file: "./token.txt" } } }`。runner 用
  `auth: { jwt: { issuer: "https://issuer.example", audience: [graft], algorithms: [ES256], keys: { publicKey: "./public.pem" } } }`；JWKS 则用
  `keys: { jwksUrl: "https://issuer.example/jwks" }`。`identityClaim` 默认
  `sub`，`clockTolerance` 默认 `5 seconds`。身份 claim 必须是非空字符串，`exp`
  必填，存在 `nbf` 时也会验证。
- **None**：runner 的 `auth: { none: { identity: billing } }`
  只指定名字，不认证调用者。

缺失或无效的 bearer/JWT 在 upgrade 前返回 401 和
`WWW-Authenticate`。JWT 只在这时验证，连接期间过期不会断开。token 被盗后在有效期内可以重放；建议用 wss 和较短的有效期。

## mTLS 证书

wss 需要服务器证书和受信任 CA；mTLS 的客户端证书由专用 CA 签发：

```sh
graft-remote certificates --out certs --server runner.example --identity billing
```

也可使用其他工具。运维保管
`ca.key`；服务器证书和私钥部署到 runner，`client-billing.crt`/`.key`
部署到宿主，两边都需要
`ca.crt`。服务器证书须匹配主机名。mTLS 客户端证书须有恰好一个 `graft://` SAN
URI，例如 `graft://billing`；允许其他 URI
SAN 共存。轮换证书时保持身份不变，就能保留实例命名空间。

客户端 `auth.mtls`
的写法见[宿主配置](../host/#从-yaml-或-typescript-加载)，服务器端见
[runner 配置](../runner/#配置-runner)。command 连接按
[SSH/stdio 部署说明](../runner/#通过-ssh-连接)配置。

## 信任与限制

Remote 信任 runner 的安装、配置、OS、本机权限、专用 CA 以及配置的 JWT 签发者和密钥。不支持浏览器宿主、Web
Worker、token 刷新、连接期间重新认证、吊销列表、密码、对称 JWT、代理转发的证书头、关闭 TLS 校验、代码分发、runner 故障切换或调用重放。
