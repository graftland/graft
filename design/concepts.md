# 概念清单与概念预算

> **已被取代**：本文已被 [`architecture.md`](architecture.md)
> v1.0（2026-11-07）取代，仅作历史参考；保留的内容已并入该文，未并入的内容及原因见其附录 A。

状态：草案 v0.3，2026-11-07，供讨论。v0.3 把 HMR 并入发布流水线的开发配置（2.2）。本文不是站点文档，不受
`packages/docs/STYLE.md` 约束。v0.1 经过一轮独立审查（Codex
gpt-6-astra，只读，逐条对照代码），审查结论见附录。配套文档：[`changes.md`](changes.md)（统一变更模型）。

## 0. 为什么要有这份清单

Graft 目前有 13 个包、49 页英文文档、约 80 个导出的错误类与结局联合类型。用户要学的名词在增加，同一个词在不同包里的含义也在分叉。本文：

1. 盘点一词多义、多词一义，以及只为保护一个机制而存在的概念；
2. 给出目标词表，并标明谁需要学每个词；
3. 定下规则，让新增的概念必须「付费」。

**衡量的对象是读者必须理解的独立规则，不是导出名的数量。** 限定名（如
`Artifact.Identity` 与
`Manifest.Identity`）已经表达了不同的主体，不算负担；期限、唯一所有者、租约排空、信任检查是规则，不是需要删掉的保护。

## 1. 规则

| 规则                   | 内容                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 核心词一词一义         | 第 2 节词表里的词在所有包里只有一个含义。其他场合用限定名或限定语境，不复用裸的核心词                                                                |
| Effect 的词优先        | `Scope`、`Layer`、`Context`、`Schedule`、`Fiber`、`HttpApiGroup` 等沿用 Effect 的含义；Graft 不重新定义，也不给 Effect 自己的 `provide` 强加别的含义 |
| 名字即标签             | 错误类的类名与 `_tag` 一致。今天 `Denied` 的标签是 `"CapabilityDenied"`，`RegistrationError` 的标签是 `"AdmissionRegistrationError"`                 |
| 不留只存在于文档的名词 | 文档里的名词要么对应导出的类型，要么写进词表并给出定义。今天的「integration」只存在于文档                                                            |
| 新概念要付费           | 新增公开名词的改动要说明：这个词是什么、谁要学、它替代或删掉了什么                                                                                   |
| 保护性概念是信号       | 一个概念如果只为防止机制 A 破坏机制 B，就检查 A 与 B 能否合并。删除前要写明它保护的性质由谁接手（[`changes.md`](changes.md) 第 4 节）                |
| 读者分层               | 每个词标明读者；应用作者的必学词表保持在 10 个以内                                                                                                   |
| 文档随切片更新         | 每个改名或删除在同一次改动中更新三种语言的文档，不留到最后                                                                                           |

## 2. 目标词表

读者：**A** 应用作者，**P** 插件作者，**O** 运维，**X** 扩展与驱动作者。

### 2.1 组合（参照 cordis）

| 词        | 唯一含义                                                  | 读者 |
| --------- | --------------------------------------------------------- | ---- |
| Plugin    | 描述如何启动一项能力的值：配置、依赖、提供的服务、`apply` | A P  |
| Service   | 运行时用 `Graft.provide` 发布、撤回的 Context 键          | A P  |
| Event     | 带类型的事件令牌                                          | P    |
| Realm     | 键与事件的可见范围                                        | A P  |
| Intercept | 对一棵子树的 `Context.Reference` 打补丁                   | A P  |
| Entry     | `graft.yml` 中的一项（源配置条目）                        | A O  |
| Loader    | 把条目变成 fork 并持续协调                                | A    |

发布快照中的条目（`plugin-release` 的
`Entry`）与源配置条目共享条目 id，但模型不同：前者带制品、来源、探针等。词表把它们写成「源配置条目 → 发布快照条目」，不当作同义词。

### 2.2 生命周期与变更（参照 Erlang/OTP）

三层，自外向内：

| 词            | 唯一含义                                                                                              | 读者 |
| ------------- | ----------------------------------------------------------------------------------------------------- | ---- |
| Instance name | 逻辑实例的稳定名字；可以跨 fork 重建保持不变（Loader 条目 id 就是实例名）                             | O    |
| Fork          | 一次加载注册的长期句柄，在本 fork 的重启之间存在；父激活重建或 Loader 形状变化时会换新的 fork         | A O  |
| Generation    | fork 的一次执行：从启动到终止。`InPlace` 不产生新的一代，只更新该代的配置版本                         | O P  |
| Unit          | 承载执行的边界：一个 Worker、一个子进程。连接断开不能证明执行退出；将来部署组里一个 Unit 承载多个实例 | X    |

activation 保留为 Effect
Scope 所有权的技术词，用在内核与驱动作者的文档中，不新增公开类型。今天一个托管宿主的 activation 可以管理多个先后或重叠的尝试，所以 activation 与 Generation 不是一一对应。

| 词         | 唯一含义                                                                           | 读者 |
| ---------- | ---------------------------------------------------------------------------------- | ---- |
| Candidate  | 期望配置加输入快照；转换的目标（[`changes.md`](changes.md) 2.1）                   | O X  |
| Change     | 一次有稳定身份和所有者的变更操作                                                   | A O  |
| Strategy   | 一个 fork 换代的执行方式：`InPlace`、`Restart`、`Overlap`，将来 `Handoff`          | O P  |
| Transition | 执行变更的协议                                                                     | O    |
| Outcome    | `Accepted`、`Aborted`、`Recovered`、`RecoveryFailed`、`Stuck`                      | A O  |
| Probe      | 插件用 `Plugin.probe` 注册的具名健康检查                                           | P O  |
| Release    | 应用发布：不可变的插件与配置集合                                                   | O    |
| Dev mode   | 发布流水线的开发配置：监听文件变化，构建开发候选，经同一个转换换代，只在内存中记录 | A P  |

`Transition.Policy`
拆成两部分：`budget`（各阶段最多等多久）与执行要求（运行哪些探针、试运行观察多久）。试运行时长是「至少观察多久」，不是期限，不能并入预算。

HMR 不再是独立概念，而是发布流水线的开发配置（Dev mode，见
[`changes.md`](changes.md)
2.10）。用户学的是「发布」与「开发模式」，不再单独学一套热重载的规则与 `Skipped`
原因。第 3.1 节中 HMR 的 module snapshot、import
attempt 等说法只在进程内重载机制删除之前保留为内部词。

### 2.3 放置与契约

放置不是一根轴，而是两根：

| 轴           | 取值                                               |
| ------------ | -------------------------------------------------- |
| 执行方式     | 宿主内、Worker、子进程                             |
| 由谁启动管理 | 宿主直连、runner（经 Unix 套接字、命令或网络连接） |

| 词        | 唯一含义                                | 读者 |
| --------- | --------------------------------------- | ---- |
| Placement | 上面两根轴的组合                        | O P  |
| Artifact  | 捕获的、内容寻址的插件目录              | O    |
| Contract  | 一组带版本的操作及其 Schema             | P X  |
| Manifest  | 插件包 `package.json` 中的 `graft` 字段 | P    |
| Driver    | 转换的扩展点                            | X    |
| Facade    | 跨代稳定的服务对象                      | X    |

### 2.4 信任

core `Trust`
提供通用的原子准入机制，remote 的信任策略实现等级、授予与撤销规则。这是机制与策略的分工，文档已经写明，不是冲突。

| 词           | 唯一含义                                                                | 读者 |
| ------------ | ----------------------------------------------------------------------- | ---- |
| Trust policy | 运维的信任策略文件：等级、授予、批准                                    | O    |
| Grant        | 一项被授予的能力                                                        | O P  |
| Capability   | 由宿主代管、可授予的权限（HTTP、文件）；传输与认证插件不再叫 capability | O P  |
| Projection   | 把契约操作呈现给外部协议的视图（领域概念）                              | O    |

Projection 在 API 上保持分层：`Trust.Projection` 是不解释内容的审批描述，MCP 的
`Projection`
负责校验元数据、建立工具绑定，再把描述发布给 Trust。core 不依赖 MCP 的类型。为了区分，`Trust.Projection`
可以改名为 `ProjectionDescription`。

## 3. 冲突

### 3.1 一词多义

| 词           | 现有含义                                                                                                                                                    | 提议                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Release      | core `Release.ts`（加强 cause 保留的 Scope 关闭）；`releases.md`（Graft 自己的发布流程）；`plugin-release`                                                  | core 模块改名为 `ResourceRelease`；`releases.md` 移到维护者文档并改名为 Publishing；Release 只指应用发布                         |
| Generation   | 转换的一代；HMR 的模块图视图；runner 在打开执行时分配并持久化的代号（高水位，不是进程启动次数）；文档里的条目代、观察代、文档代                             | 只指 fork 的一代。HMR 的改为 module snapshot；runner 的改为 incarnation（含义写成「打开执行时分配的持久化代号」）；其余改写      |
| Attempt      | 转换的尝试编号；HMR 对 URL 的导入尝试；探针文档里的「serving attempt」                                                                                      | 公开 API 并入 Generation；HMR 内部保留                                                                                           |
| Candidate    | 转换候选；HMR 新导入的插件；`ModuleResolver` 的说明符拼写；`Trust.check` 的身份参数                                                                         | 只指转换候选；其余改为 imported definition、specifier spelling、identity                                                         |
| Entry        | 源配置条目；`Manifest.Entry`（入口的元数据记录，导出子路径是 `PublicEntry`）；HMR 的模块 URL；发布快照条目；`Artifact.Identity.entry`；`Trust.check(entry)` | `Manifest.Entry` → `EntryMetadata`；HMR 的改为 module；`Artifact.Identity.entry` → `module`；`Trust.check` 的参数改为实例名      |
| Target       | 转换请求的实例名或 fork id；Loader 持久化的条目；`CandidateOptions.target`（放置）；发布计划的目标 id；`create` 的目录                                      | 转换请求改用变更的选择器；放置改为 `placement`；发布的改为 `release`；Loader 内部的改为 `desired`                                |
| Instance     | 文档说 Fork 是「一个运行中的实例」；托管实例名；remote 的 `Instance`（实例名 + runner 代号）                                                                | 只用 Instance name；remote 的 `Instance` 改名为 `CurrentExecution`，字段写明实例名与 incarnation；需要全局身份时带上认证命名空间 |
| Host         | `Manifest.Host`（版本、能力、已提供的服务与操作）；remote 的宿主侧配置；宿主进程；宿主插件；`host/` 子路径                                                  | `Manifest.Host` → `HostProfile`；remote 配置改为 `HostOptions`；其余保留为「宿主」这一角色                                       |
| Event        | core 的事件总线；`plugin-release` 的日志记录                                                                                                                | 后者改为 `JournalRecord`                                                                                                         |
| Manifest     | core 的 `graft` 字段；`package-manager` 的 `package.json`；`release.json`                                                                                   | 后两者改为 `PackageJson`、release record                                                                                         |
| Publication  | 信任中视图的内容；remote 的作者元数据工具                                                                                                                   | remote 的改为 `Packaging`；信任的随 `ProjectionDescription` 改写                                                                 |
| Group        | Loader 的条目分组；设计中的部署组；`HttpApiGroup`                                                                                                           | `HttpApiGroup` 是 Effect 的词，保留；部署组用限定名 `DeploymentGroup`，与 `Loader.Group` 足以区分                                |
| retry        | 插件的 `retry` 调度；`Loader.retry`                                                                                                                         | `Loader.retry` 并入变更的选择器（[`changes.md`](changes.md)）                                                                    |
| Termination  | 转换的 `Termination`；`package-manager` 的进程终止                                                                                                          | 后者改为 `ProcessTermination`                                                                                                    |
| Capabilities | 传输与认证插件（remote 文档）；宿主能力代管                                                                                                                 | 只指能力代管；前者改称 transport plugins                                                                                         |
| Policy       | 转换的 `Policy`；信任策略                                                                                                                                   | 转换的拆为 `budget` 与执行要求（2.2）；Policy 作为普通词允许在限定语境中出现                                                     |

`Identity`
的八种形状都已带主体限定，不改。`Artifact.Identity`（算法版本 + 摘要 + 实现入口）与信任策略的身份（包 + 摘要）**不合并**：前者区分同一目录中的入口，后者用于包级的策略匹配。可以共用摘要的底层 Schema，并写明二者的映射与审批粒度。

### 3.2 同名不同类

| 名字                  | 位置                                                 | 提议                                                                                           |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ConformanceError`    | `plugin-http`、`plugin-otlp`、`plugin-remote` 各一个 | 只在它们会进入同一个错误联合时才处理；否则保留                                                 |
| `AmbiguousPluginName` | `loader` 与 `create` 各一个                          | 不为此让 `create` 在运行时依赖 `loader`（今天只是开发依赖）；若要共享，放到双方已有的更低层包  |
| `Catalog.Conflict`    | MCP                                                  | 改为 `CatalogConflict`（`Extensions.Conflict` 的标签已经是 `ExtensionConflict`，只需类名对齐） |
| `RecoveryFailed`      | `ReplaceResult` 与 `Transition.Outcome`，形状不同    | 随 [`changes.md`](changes.md) 步骤 3 合并                                                      |

### 3.3 多词一义

| 同一件事       | 现有叫法                                                                                                                                       | 统一为                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件的执行     | fork、activation、serving attempt、attempt、unit、execution unit、plugin process、direct unit、generation                                      | 按 2.2 分层：Instance name、Fork、Generation、Unit；activation 只作技术词                                                                      |
| 运行在哪里     | `Manifest.Placement`、`CandidateOptions.target`、`local`/`worker`、direct placement                                                            | Placement（两根轴）。`local`/`worker` 是普通 Remote 连接配置的字段，`Local`/`Worker` 是清单与候选的标签：是两个 API 的不同表示，待决定是否统一 |
| 实例的稳定名字 | Loader 条目 id、`CurrentInstance`、`Registration.instance`、`ManagedOptions.instance`、`Trust.check` 的 `entry`、信任策略的 `Assignment.entry` | Instance name                                                                                                                                  |
| 失败后回到旧版 | `RolledBack`（两处）、`Recovered`、发布的 `rollback` 命令                                                                                      | 结局一律叫 `Recovered`；`rollback` 只指运维主动切回上一个发布                                                                                  |
| 托管与普通     | `ManagedHost`/`OrdinaryHost`、`managedPlugin`/`unmanagedPlugin`、managed entries、managed integrations                                         | 统一入口；能力差异（一元契约、注入限制、信任准入）保留为显式检查                                                                               |

发布类动词按语境限定，不强行统一成一个：

| 动词                  | 用途                                            |
| --------------------- | ----------------------------------------------- |
| `Graft.provide`       | 把服务值发布到 realm                            |
| `advertise` / `offer` | 向外部协议贡献操作（HTTP、MCP）；待统一为一个词 |
| `declare`             | 声明协议扩展字段（MCP `Extensions`）            |
| `register`            | 向扩展点登记实现（驱动、命令、信任权威）        |
| `Trust.publish`       | 提交审批视图的事实，并保持作用域所有权          |

要先区分「声明」「贡献到索引」「开始服务」「发布审批事实」这几种动作，再决定
`advertise` 与 `offer` 合并为哪一个。

## 4. 保护性概念

只为防止一个机制破坏另一个机制而存在。删除条件见 [`changes.md`](changes.md)
第 4 节：每一项都要先有替代机制。

| 概念                                              | 渗透范围                                                                                                                                                                                                                                         | 保护的性质                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `ManagedFork`、`assertUnmanaged`、`withUnmanaged` | `Fork.update`/`restart`/`state`/`await` 的错误类型、`Plugin.Update`、`Loader.EditError`、`Loader.retry`、CLI `Start`、`ReplacementConflict.reason`、HMR 的 `Skipped`；至少五页文档（transitions、fork-handle、replace、config-file、hot-reload） | 绕行写入不与协调器竞争；外部写入与驱动注册不交错    |
| 托管注册对 `retry` 与图解析依赖的禁令             | 托管 fork                                                                                                                                                                                                                                        | 激活循环不在协调器背后自行重启                      |
| `Plugin.overlap` 加 `OverlapRequired`             | 插件定义、驱动描述、转换原因                                                                                                                                                                                                                     | 保留，但改为 `Overlap` 策略的前提，不再是托管的前提 |

表达真实语义差别、应当保留的区分：`ReleaseInterrupted`（改名后）区分释放被中断与取消；`RemoteWithdrawn`（远端导出租约已撤回，消费者需先排空）、传输关闭、`RemoteTerminationUnconfirmed`（退出未确认）是三个不同的事实，要分别准确命名。

## 5. 文档与代码的出入

| 出入                                                                                                                                             | 处理                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `concepts.md` 只列了 8 个词，却声称 Graft「没有平行的词汇」；Probe、Transition、Generation、Contract、Artifact、Release 等都有独立页面却不在其中 | 改成第 2 节词表的读者版本，作为核心词的入口 |
| `trial` 没有词表条目                                                                                                                             | 作为转换的执行要求写进转换文档              |
| `releases.md` 与 `application-releases.md` 并存                                                                                                  | 前者移到维护者文档                          |

## 6. 如何防止复发

| 手段       | 内容                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 词表即索引 | `concepts.md` 列出每个核心词，每个词链接到唯一负责它的页面                                                                                                    |
| 构建检查   | 从 TypeDoc 的 JSON 中检查三件事：核心词表中的词是否被其他公开路径以不同含义导出；同一错误联合内的标签是否有歧义；类名与 `_tag` 是否一致。不对所有局部同名报错 |
| 术语漂移   | 文档检查核心词是否以词表之外的含义出现（可先从一份禁用说法清单开始，例如「运行中的实例」指 Fork）                                                             |
| 审查清单   | 新增公开名词的改动写明第 1 节「新概念要付费」的三项                                                                                                           |
| 定期盘点   | 每完成一个切片，重新跑一次本文的盘点                                                                                                                          |

## 7. 交付顺序

| 步骤 | 内容                                                                                                                                                                                                     | 依赖                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1    | 加构建检查，先把现有例外列入白名单                                                                                                                                                                       | 无                                          |
| 2    | 不依赖变更模型的改名：`ResourceRelease`、`HostProfile`、`EntryMetadata`、`PackageJson`、`JournalRecord`、`ProcessTermination`、`CatalogConflict`、`Plugin.Contract` → `Variance`、名字与标签不一致的错误 | 1；每改一项从白名单删一项，并同步文档       |
| 3    | Instance name、`CurrentExecution`、Placement 的两根轴、`Transition.Policy` 的拆分                                                                                                                        | 与 [`changes.md`](changes.md) 步骤 1–2 一起 |
| 4    | Generation、Candidate、Change、Strategy；随各路径迁移删除第 4 节的保护性概念                                                                                                                             | [`changes.md`](changes.md) 步骤 3–5         |
| 5    | 重写 `concepts.md` 站点页                                                                                                                                                                                | 每步已同步文档，这一步只做整合              |

项目尚未发布稳定版本，改名不保留旧名，也不提供兼容别名。

## 8. 待决问题

| 问题                                                  | 倾向                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| core `Release` 模块的新名字                           | `ResourceRelease`                                      |
| `advertise` 与 `offer` 合并为哪一个                   | 先区分四种动作再定                                     |
| `local`/`worker` 与 `Local`/`Worker` 两种表示是否统一 | 倾向统一到放置的两根轴上                               |
| `Trust.Projection` 是否改名为 `ProjectionDescription` | 倾向改                                                 |
| incarnation 这个名字                                  | 可以讨论；关键是定义写成「打开执行时分配的持久化代号」 |

## 附录：审查结论

v0.1 由 Codex（gpt-6-astra，只读）对照 `main` 的 `0cdcaa7`
审查。主要意见与处理：

| 意见                                                                                          | 处理                           |
| --------------------------------------------------------------------------------------------- | ------------------------------ |
| runner 的 generation 在打开执行时分配，不是进程启动计数（已核实）                             | 3.1                            |
| `Manifest.Entry` 是元数据记录，导出子路径是 `PublicEntry`；发布条目与 Loader 条目不是同一模型 | 2.1、3.1                       |
| 信任的机制与策略之分、`local`/`worker` 大小写，都不是文档错误                                 | 从第 5 节删除，改写到 2.4、3.3 |
| `RemoteWithdrawn` 表示导出租约撤回，不是传输关闭（已核实）                                    | 第 4 节                        |
| Fork、Generation、Unit 不是同义词；`InPlace` 不产生新的一代；实例名可跨 fork 存在             | 2.2 重写为分层                 |
| Trust 与 MCP 的 Projection 是抽象关系，不能合并成一个类型                                     | 2.4                            |
| `Finalize`、`Platform`、`Process`、`UnitIdentity`、colocation、`Export` 会造成新的误导        | 3.1、2.3 换名                  |
| `Budget` 装不下探针名单与试运行时长                                                           | 2.2 拆分                       |
| `offer` 不能覆盖所有发布类动词                                                                | 3.3 改为按语境限定             |
| 全局同名检查会扩大负担；为消除重名引入 `loader` 依赖不必要（已核实为开发依赖）                | 第 1、6 节，3.2                |
| `Artifact.Identity` 与信任身份不能直接合并                                                    | 3.1                            |
| 保护性概念删除前要有不变量清单；预算应衡量独立规则                                            | 第 0、1、4 节                  |
