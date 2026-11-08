---
title: 发布制品
description: 构建不可变发布目录。
---

`@graftland/plugin-release`
从包元数据构建内容寻址的发布目录。它导出存储数据与校验；部署使用[内核变更 API](../transitions/)。

## 构建

向 `build` 提供存储目录和源文件，返回值标识不可变目录。`metadataOnly`
避免导入包代码。[发布记录者](../recording/#读取日志)会把被记录的变更写入日志。
