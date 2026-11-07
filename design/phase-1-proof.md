# 阶段 1：Change 内核验收记录

验收依据是
`design/phase-1.md`。这里区分纯模型探索、生产执行器适配和真实 Remote/打包检查；不把模型穷举数当成真实调度运行数。

## 提交与检查

| 步骤 | 提交           | 内容                                                                                       | 提交前验证                                                             |
| ---- | -------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1    | `01b9c66`      | Change 类型、错误、请求规范化；模型迟到释放与容量                                          | typecheck；core 826 项                                                 |
| 2    | `ad88d1d`      | activation 代令牌、解析/lease/发布所有权、跨代环检查；保留中断 cause                       | typecheck；core 829 项                                                 |
| 3    | `b123fb6`      | 实例索引、局部读写预留与版本、运行时所有权、查询/事件、键保留；删除 Graft.transition       | typecheck；core 835 项；loader/release 284 项                          |
| 4    | `6229f40`      | Restart、取消边界、恢复与预算、暂停队列、maxUnits、原始宿主清理所有者                      | typecheck；core/loader/hmr 共 1,201 项                                 |
| 5    | `85b2cee`      | 并行迁移 Remote/release；元数据准备、授权版本、fresh resolve、任期、拒绝补偿与版本前提     | typecheck；core/release 873 项；Remote 401 通过/1 平台跳过；docs 41 项 |
| 6    | 本文件所在提交 | 三语文档、sample、真实模型适配器、打包证明；真实适配发现的准入/lease/retain/注册所有权补漏 | 见最终检查表                                                           |

所有提交均保留规定的 Conventional
Commit 和 Co-Authored-By。未 push、未运行 gh、未发布。

## 阶段 0 场景映射

原场景名取自 `packages/core/test/change-model.test.ts`；最后四条取自新增的
`change-model-settlement.test.ts`。表内“推迟”指完整场景，不把已验证的单成员子性质冒充完整多成员协议。

| 场景                                                                                         | 状态                                           | 生产证据或边界                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| retains leased consumers in a Stuck conflict set while unrelated work completes              | 推迟到阶段 3：完整 lease 消费者闭包            | 单成员 Stuck 隔离由真实 adapter 验证；真实执行代 lease 由 change-leases 验证；多成员计划 API 未提供                                                                                      |
| reaches an outcome at the budget boundary for every bounded lease cleanup interleaving       | 推迟到阶段 3：多成员交错                       | 单成员 deadline、未知宿主清理、恢复与 trial 已有执行器测试；完整多成员穷举仍只属于模型                                                                                                   |
| settles exited generations leases without claiming finalizer success                         | 已实现原语；完整双成员场景阶段 3               | change-leases 实测退出后释放旧 Unit lease、宿主清理仍阻塞；未知清理保留 cause，可能为 Stuck                                                                                              |
| waits for affected nonmember participants without a global barrier                           | 推迟到阶段 3（参与者闭包）；跨单元确认阶段 2   | 适配器显式不接受参与者计划，不伪造确认                                                                                                                                                   |
| preserves both patches in every interleaving from the same base                              | 已实现单成员 patch 协议                        | adapter 驱动原 independent 场景的正序、逆序、交错三条真实轨迹；12,870 次枚举是模型证据                                                                                                   |
| reserves complete conflict sets atomically across three competing changes                    | 推迟到阶段 3：多成员集合                       | 当前单目标实例/门面 slot/捕获 edge 的原子预留已实现；多成员计划未提供                                                                                                                    |
| recovers only owned patches while an unrelated change commits                                | 已实现                                         | change.test：A 的真实恢复 readiness 被 Deferred 阻挡时 B Accepted；A 实际版本 3、B 版本 2 均保留                                                                                         |
| keeps Stuck local with constant admission and commit object probes                           | 已实现                                         | adapter 验证 A Stuck 时 B Accepted；真实 TxRef Proxy 记录 100 个无关对象访问为 0；不声称负载下延迟恒定                                                                                   |
| rejects stale plans including optional absence and absence ABA                               | 已实现                                         | metadata 准备前记录内部版本；真实 Graft.provide/withdraw 造成 slot 0→1→2，准入拒绝 Stale；不依赖 caller.expected                                                                         |
| allows shared read premises while fencing their writer                                       | 已实现                                         | change-leases：A/B 使用同一稳定门面时，provider C 保持该绑定的 Change 可并行 Accepted；Phase 1 不改变绑定发布或所有权，三者共享 slot read；真正的发布/撤回仍推进 slot 版本并使旧前提失效 |
| rejects acknowledgements with stale change generation or view identity                       | 已实现 Unit 令牌校验；远端路由 view 确认阶段 2 | 分配/每步响应比较完整 Change/generation/routeVersion/term；错误 generation 在 Unit.start 前被拒绝；adapter 不模拟跨单元确认协议                                                          |
| keeps generations resolution leases and publication cleanup independent                      | 已实现单代原语；provider 成员一起换代阶段 3    | 真 managed 代拥有解析与 retain；旧退出重复到达不碰新 lease；旧发布清理测试覆盖 token fencing                                                                                             |
| requires deployment group and local lease consumer closure                                   | 推迟到阶段 3                                   | 未提供 group/成员集合请求；当前目标必须已注册且固定捕获 footprint；不把 adapter 的 UnsupportedModelAction 当作 ChangeRejected                                                            |
| distinguishes equal service keys in different realms                                         | 已实现                                         | adapter 三个实例发布相同 Value key 于独立 realm，A/B 可并行；打包 secondary 实例也使用真实 isolation                                                                                     |
| does not self-preempt planned withdrawal and never swallows invalidation as Busy             | 已实现单成员                                   | 门面不重发；route commit 只推进实例版本；外部 slot/授权版本变化产生 Stale/Closing 并进入结算，不吞成 Busy                                                                                |
| enumerates invalidation cancellation acknowledgements and shutdown at every bounded position | 推迟到阶段 2/3/4：完整混合状态探索             | 单成员取消两侧、失效与 shutdown 实测；跨单元 ack、闭包与 supervisor 未借适配器实现                                                                                                       |
| settles every admitted change after shutdown across all submission interleavings             | 已实现单成员运行时关闭协议                     | transition 的 admission/shutdown 测试；已准入结局如实为 RecoveryFailed/Stuck；2,772 次完整提交交错仍是模型证据                                                                           |
| treats cancellation after stopping old generations as recovery before route switch           | 已实现                                         | change-restart：真实停止边界后 cancel，fresh resolve，完整恢复 trial，Recovered                                                                                                          |
| refuses recovery after losing an owned version and preserves failure causes                  | 已实现单成员版本前提                           | commit/recovery 校验内部版本；授权 ABA、外部 slot 失效；release 真实 later-version 补偿冲突不会覆盖；完整成员闭包阶段 3                                                                  |
| exposes counterexamples to snapshot replacement and fork-wide lease release                  | 已实现反例防护                                 | adapter 逆序/交错 patch；生产 managed generation lease/retain 与重复退出测试，旧 token 不清新代                                                                                          |
| releases Stuck reservations after late settlement without changing the outcome               | 已实现                                         | adapter 观察生产自动 release，原 Stuck 不变，新 Change 取得新预留；adapter 不调用 release                                                                                                |
| keeps cleanup evidence monotonic when exit evidence is repeated                              | 已实现                                         | change-leases 与 late settlement 保存完整 cause；原始 host close 结果只记录一次，不把第二次 close 当证据                                                                                 |
| detects absence presence absence with a monotonically increasing object version              | 已实现                                         | 真实 provider 发布/撤回的内部 slot 前提与墓碑版本测试                                                                                                                                    |
| reserves Restart capacity through old exit and recovery at the unit limit                    | 已实现                                         | change-restart 在 maxUnits=1 真实运行旧退出、候选失败和恢复；显式 Overlap 在执行前拒绝                                                                                                   |

`change-model/adapter.ts` 只控制真实驱动的 start/readiness、退出和 host
finalizer
gate。Submit、版本、预留、提交、容量、lease 和迟到释放均由生产模块执行。`ReleaseReservations`
动作只是等待读取到生产预留已释放；没有替生产代码释放。适配器拒绝不支持的模型动作，这种测试夹具拒绝不是运行时协议证明。

## 决定与偏离

- 保留原始 host release owner；metadata
  Scope 也用 STM 单一所有者保存原始 Exit。纯中断的归因未解决时保持 Unknown/Stuck，不二次 close 来“修好”。两份上游草稿未绕过，也未对外提交。
- 新增 `Driver.prepare` 与静态 `package.json` 的
  `graft.overlap`。摘要验证证明声明来源，不证明任意插件代码行为。无声明默认 Restart；显式不支持的 Overlap 在执行前拒绝。
- 新增
  `Trust.Comparison.revision`，并建立 per-entry 索引；同声明重复 bind 不自我失效，授权 ABA 可见。operator
  publish/revoke 仍有控制面扫描，详见 Remote 交接，未宣称这些路径局部。
- `Driver.footprint` 在 fresh
  resolve 后比较 artifact/contract/placement；凭证可轮换，资源选择不可偷偷改变。
- 单成员捕获使用注册 activation 的固定解析；每个 managed
  Unit 再拥有自己的 generation lease/slot
  retain。注册 activation 自己的解析也仍有所有者。捕获前提改变后不能继续使用该注册来执行旧计划。
- 第 6 步真实证明暴露并补齐了第 2/3 步遗漏：managed 捕获解析此前仍被旧限制拒绝，执行代未取得 lease；absence
  watch 被 withdrawal 清空后 retain 无法释放；注册 scope 退出与未知执行的名称 fencing 不完整。没有重写前五步提交，修复与失败测试保留在第六步，便于追溯。
- 完整 group/closure、跨单元路由确认、supervisor/Committed 和 batch
  reservations 按规格分别留到阶段 3、2、4、5。没有把这些功能藏在适配器里。
- 通用远端请求 Scope
  drain（包括 unary）仍不支持。已通过的打包检查只证明其实际观察的门面、会话、Unit 退出和 Change 结局。

## 失败过的检查

| 检查                 | 失败与处理                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 初期 devenv 并发入口 | treefmt cache lock；随后入口串行。Remote 最终验证为单一测试进程，早期共享构建 cache 的批次不作为最终证明                                                                                                   |
| 初期 project 选择    | `--project core` 不匹配实际包名；改为 `@graftland/graft`                                                                                                                                                   |
| 第 3 步跨插件批次    | Remote 尚未迁移，33 项失败；core/loader/release 当步验证独立通过，Remote 在第 5 步完整迁移                                                                                                                 |
| Remote 迁移          | 预算/旧拒绝语义、初始授权、wrapper 未转发 prepare、metadata 清理所有权、trial=0 的 1ms 错误期限；全部具体批次见 Remote 交接                                                                                |
| 类型检查             | 开发中出现陈旧 dist、错误 Effect API 名称、泛型 unknown、exact optional/作用域需求及诊断；修正后验证，不关闭诊断或用断言强行通过                                                                           |
| 第 6 步 adapter      | 先缺模块而红；随后错误 Array API/夹具 allocation 记录缺失导致失败或等待，修正实际驱动信号；一个挂起批次中断后重新跑过                                                                                      |
| 第 6 步真实 lease    | 注册旧限制拒绝固定 graph deps；修复后原 slot-isolation 抓到清空 watch 丢失 retain，增加独立 owned retain 列表后通过                                                                                        |
| 第 6 步恢复交错测试  | 夹具误用不存在的 TxRef.updateAndGet，导致等待 trial 超时；改用原子 modify，去掉临时诊断输出后通过                                                                                                          |
| 首次全量 build       | TypeDoc 使用的 TS 检查抓到 Control 回复联合推断出的可选 undefined；显式限定 JSON 回调返回后，92 个公开入口与站内链接验证通过                                                                               |
| 首次全量 test        | public-api 独立消费者夹具仍使用 numeric target、never error、policy 和 Busy outcome；迁移为 instance/ChangeRejected/budget 并独立证明拒绝与结局                                                            |
| 最终全量 test        | 2 项 benchmarks 测试失败：进程审计读取 `/proc` 得到 ENOENT；Remote 等价测试的 Unix 连接监听 `/proc/self/fd/12/runner.sock` 得到 EACCES。均为未改动的 Linux 路径在 macOS 上不可用，未跳过测试或伪造退出证据 |

## 最终检查

| 检查                                   | 真实结果                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                       | 通过；全量检查含 Effect language service                                                                                     |
| `pnpm test`                            | 未全绿：317 个文件通过、2 个 benchmarks 文件失败；2,386 项通过、46 项跳过、2 项失败。两项平台失败见上表，仍需 Linux 环境验收 |
| `pnpm build`                           | 通过；TypeDoc 校验 92 个公开入口，文档生成 2,662 页并检查站内链接，sample 编译通过                                           |
| `node scripts/packed-gateway.mjs test` | 27 项通过，包括 Worker/Local 两实例并行 Change、稳定会话和门面                                                               |
| `treefmt` 与 `git diff --check`        | 通过；首次只格式化验收记录，第二次无额外变化                                                                                 |

规格 Proof 第 5 条的“tests 全通过”仍未达成。建议在 Linux 环境运行同一份全量检查并保留原生进程退出审计；若要求 macOS 同样验收，需要另行定义可提供等价证据的进程审计和 Unix 路径支持，不能用空进程列表代替。其余已授权部分继续完成并提交。

全量测试日志保存在本地忽略目录 `.cache/phase-1-test.log`；构建日志在
`.cache/phase-1-build.log`。不会把平台失败写成通过，也未绕过两项 Effect 上游缺口。

## 建议重点审查

1. generation 的独立 retain 列表与 withdrawal 的 watch 清空是否在所有退出/重复清理路径上平衡；长生命周期注册解析和各 Unit 解析分别由谁拥有。
2. registration scope 关闭、实例索引 tombstone、晚到 exit/host
   cleanup 与重新注册的 owner/pointer 检查。
3. admission 的 preflight snapshot 与 metadata
   Scope：重复键优先、准备期间版本变化、读集合/edge 是否完整。
4. Policy
   per-entry 索引、服务所有者计数和每种授权修改的 revision 推进。控制面扫描边界保持可见。
5. recovery 与 cleanup 的总预算预留，尤其极限容量、old
   stop 已发出但 ack/exit 尚未到、未归因中断的结局。

## 新增回归测试名

以下列出新增/关键补充测试，不重复列出每步都运行的全部既有测试名。Remote 的动态 Worker/Local 名称及迁移失败清单见
`phase-1-remote-notes.md`；release 细节见 `phase-1-release-notes.md`。

### 第 1 步：`01b9c66`

`packages/core/test/change-request.test.ts`

- normalizes duration inputs defaults and absent optional fields
- includes expected versions and desired deployments in key equality
- reserves both the forward and recovery trial in the total budget
- rejects invalid finite budgets before admission

`packages/core/test/change-model-settlement.test.ts`

- releases Stuck reservations after late settlement without changing the outcome
- keeps cleanup evidence monotonic when exit evidence is repeated
- detects absence presence absence with a monotonically increasing object
  version
- reserves Restart capacity through old exit and recovery at the unit limit

### 第 2 步：`ad88d1d`

`packages/core/test/generation-ownership.test.ts`

- keeps two generations leased to the same provider and settles each exactly
  once
- keeps a new publication and its slot retain count after repeated old teardown
- checks withdrawn generations and parent ownership when detecting publication
  cycles

### 第 3 步：`b123fb6`

`packages/core/test/change.test.ts`

- keeps keyed admission records after bounded observation history eviction
- reads real affected object cells without probing unrelated tombstones
- confines Stuck to A and preserves its conclusion after late exit evidence
- preserves both instance patches when Changes commit in reverse admission order
- completes B while A retains its trial reservation and rejects only A conflicts
- deduplicates keys before stale and busy checks and includes expected in
  KeyConflict

### 第 4 步：`6229f40`

`packages/core/test/change-restart.test.ts`

- does not start a Restart candidate until old exit evidence arrives
- bounds paused calls and removes cancelled and expired waiters exactly once
- re-resolves the recovery target and completes its full trial after Restart
  startup failure
- reuses confirmed Restart capacity at maxUnits and rejects an unsupported
  Overlap
- aborts explicit cancellation before the old stop boundary and leaves admitted
  calls alive
- recovers after explicit cancellation crosses the old stop boundary
- keeps a Stuck conclusion while late host cleanup settles and requires a fresh
  Change to restore service

### 第 5 步：`85b2cee`

`packages/core/test/change.test.ts`

- prepares verified metadata before selecting Overlap and deduplicates before
  preparation
- detects authorization ABA before cutover without invalidating an unrelated
  Change
- retains metadata cleanup ownership after its deadline and releases only after
  its original completion
- never re-grants a term when an instance name is registered again

`packages/core/test/change-restart.test.ts`

- fences an acknowledgement from a different generation before startup and never
  reuses its term
- rejects a resolved resource footprint change before allocating the candidate

`packages/plugin-remote/test/policy-revisions.test.ts`

- retains per-entry authorization revisions through projection ABA and duplicate
  bindings
- admission and binding do not inspect unrelated policy entries

`packages/plugin-release/test/execution.test.ts`

- compensates an accepted entry when the next request is rejected before
  admission
- passes the accepted version to compensation and preserves a later accepted
  change on conflict
- uses production admission to reject B and fences compensation from a later
  accepted Change

`packages/plugin-release/test/resolution.test.ts`

- resolves rotated references for recovery from the retained desired input

`packages/plugin-release/test/storage.test.ts`

- replays admission rejection separately from admitted outcomes and failed
  compensation

### 第 5 步：Remote 动态/制品测试补充

- verifies overlap metadata without importing the implementation
- defaults an absent overlap declaration to Restart
- Worker rejects explicit Overlap without verified metadata before candidate
  execution
- Local rejects explicit Overlap without verified metadata before candidate
  execution
- Worker resolves rotated credentials from the previous desired input during
  recovery
- Local resolves rotated credentials from the previous desired input during
  recovery
- rejects a resolver that changes the verified placement footprint before
  allocation
- rejects an unapproved initial artifact before sandbox preparation or execution

### 第 6 步

- drives the phase zero independent scenario through production in forward order
- drives the phase zero independent scenario through production in reverse order
- drives the phase zero independent scenario through production in interleaved
  order
- drives Stuck isolation and late reservation release through production without
  changing the recorded outcome
- rejects an internal instance premise changed during metadata preparation
  without a caller expected version
- detects optional service absence ABA during metadata preparation using real
  publication and withdrawal
- retains available trace correlation in an admitted Change status
- recovers only A's owned patch while B commits and keeps both actual versions
- owns captured provider leases and slot retains in each real managed generation
  until its exit
- allows a stable facade provider to change while both consumers are changing
- keeps an unconfirmed disposed generation leased and fences its instance name
  until late exit
- Worker: changes a second managed instance while the first is gated in a probe
- Local: changes a second managed instance while the first is gated in a probe
