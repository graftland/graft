# @graftland/plugin-release

通过 Graft Change 提供不可变的托管应用发布、配置规划和回滚。

Change 请求被拒绝后停止前向执行，并按相反顺序补偿先前接受的条目。补偿使用对应已接受 Change 产生的版本；冲突时保留后续已接受的 Change。观察结果区分拒绝与已准入的 Change
id。每次分配都会重新解析保留的期望配置，包括恢复和补偿。

https://graftland.github.io/graft/zh-cn/application-releases/
