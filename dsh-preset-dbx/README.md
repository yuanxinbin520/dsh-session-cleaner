# dsh-preset-dbx — DBX 模式

给 DeepSeek Harness 增加一个 **DBX 模式** 的新会话模式（agent preset）：

- 组合 = 标准模式的全部能力（模型、工具、技能、子代理、工作流、计划模式等）
- 外加一个 DBX MCP 服务：`@deepseek-ai/dsh-mcp-client`，`serverName: dbx`，
  启动 `%USERPROFILE%\.dbx\bin\dbx-mcp.exe`
- 因此 41 个 `mcp__dbx__*` 工具（25 个数据库/队列工具 + 16 个 SSH/SFTP 工具）
  只出现在选择「DBX 模式」的新会话里，普通会话完全不受影响

## 用法

安装本包（bundle 补丁）后，在 Web UI 新建会话时选择 **DBX 模式**。
运行中的会话不会改变；模式在创建会话时固定。

## 安装 / 卸载

```text
# 在本仓库里，本包就是 dsh-preset-dbx/ 子目录
dsh plugin add link:./dsh-preset-dbx     # 安装（桌面版请在 GUI 插件页操作）
```

卸载即移除该模式声明，不影响任何已有会话数据。

## 在其他电脑上安装

只需要复制**本目录**（共 3 个文件：`package.json`、`cordis.patch.yml`、`README.md`），
或者复制打包好的 `dsh-preset-dbx-0.1.0.tgz` 单文件。profile 里的任何东西都不用抄。

目标电脑的前置条件：

- DSH 桌面版**同代运行时**（需自带 `@deepseek-ai/dsh-agent-preset` 与
  `@deepseek-ai/dsh-mcp-client`，本包基于 0.2.1-rc.2 生成）
- 已安装 DBX 客户端（提供 `%USERPROFILE%\.dbx\bin\dbx-mcp.exe`）；没装也不影响
  该模式使用，只是没有 DBX 的 MCP 工具

安装步骤：

1. 把目录放到一个固定位置，例如 `D:\dsh-presets\dsh-preset-dbx`
2. DSH → 插件页 → **添加插件**，填入该目录的**绝对路径**
   （`D:\dsh-presets\dsh-preset-dbx`），点安装
3. 刷新页面 / 重开窗口，新建会话的模式选择里出现 **DBX 模式**

> 用目录路径安装记录的是 `link:` 链接，安装后**不要移动或删除该目录**。
> 如果希望单文件、目录可删，改用 tgz：添加插件时填 tgz 的绝对路径。

## 维护提示

`cordis.patch.yml` 里的组合是**本版本标准模式的快照**（22 个插件行）。
DSH 升级后标准模式若新增插件行，DBX 模式不会自动跟上；需要时用新版本的
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 重新生成本补丁。

## 依赖

- DBX 桌面客户端已安装（提供 `%USERPROFILE%\.dbx\bin\dbx-mcp.exe`）
- 运行时包含 `@deepseek-ai/dsh-agent-preset` 与 `@deepseek-ai/dsh-mcp-client`

## 文件

- `cordis.patch.yml` — bundle 补丁：`- insert: [preset-dbx 声明]`
  （`@deepseek-ai/dsh-agent-preset` 行，`config.id: dbx`，`config.plugins` 为标准组合 + `mcp-dbx` 行）
