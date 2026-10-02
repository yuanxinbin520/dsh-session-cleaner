# dsh-session-cleaner

中文说明 | [English](README.md)

DSH 会话管理精简插件：只做两件事，放在会话行「…」菜单里（在 **重命名 / 归档** 等内置项下方）。

| 菜单项 | 顺序 | 行为 |
| --- | --- | --- |
| 移动到其他工作区… | 500 | 真正的跨工作区迁移：重写会话日志里的工作目录、把工件搬到新工作区、交换工作区归属 |
| 彻底删除会话… | 600 | 永久删除会话及其全部派生数据，删除前弹出确认框 |

内置项占用 `pin`(100) / `rename`(200) / `fork`(300) / `archive`(400)，本插件两项分别是 500、600，第一项带 `separatorBefore`，所以它们自成一组落在菜单底部。

## 彻底删除到底删了什么

确认框会明确列出范围，删除后返回逐项结果：

| 数据 | 处理 |
| --- | --- |
| 会话日志目录（`$DSH_HOME/sessions/<项目>/session-<id>/`） | 整目录删除，含 v4/v3/v2/v1 全部代次与临时/备份文件 |
| 运行中的会话/agent | 先 `cancel` + `dispose`，从 agent 注册表摘除，广播 `session/disposed` 让前端立刻移除该行 |
| 工作区归属 | 从所有工作区的 `sessionIds` 移除 |
| 归档 / 收藏标记 | 从 `archivedSessionIds`、`pinnedSessionIds` 移除 |
| 投影缓存（逐会话） | 删除 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`（含 `.lock` 等） |
| 投影缓存（旧版聚合文件） | 从 `storages/session_projcache.json` 的 `tables.sessions` 删除该行，并先写 `.bak` 备份 |

`attachments/`、`cache/` 是内容寻址、跨会话共享的，无法归属到单个会话，因此不在删除范围内。

安全边界：

- 只有「从工件头行证明 id 匹配」的目录才会被删；证明不了就报告 `existed: false` 并原样保留（junk/损坏目录不会被误删）。
- 目录必须严格位于 `<sessions>/<项目>/<会话>` 且两层都不能是符号链接/junction。
- 会话标识做过路径穿越校验（`../evil` 直接 400）。
- 删除用**只读头帧**定位，日志截断时仍可删除；而移动会完整解码，遇到截断的 zstd 帧会拒绝改写并保留原文件。

## 移动的语义

DSH 的工作区归属由会话头行里不可变的 `cwd` 推导，所以只改注册表会被下一次对账回滚。本插件的移动是「真迁移」：

1. 校验源/目标目录，拒绝覆盖已存在的目标工件；
2. 完整解码（多帧 zstd）并重写头行 `cwd`，把代次（`v3`/`v4`）与文件名的版本对齐；
3. 原子发布到新路径（先隐藏旧文件，失败则回滚旧文件）；
4. 运行中的会话不销毁：原地重绑 `session.header` 与写入器句柄，后续事件直接写到新文件；
5. 交换工作区归属（从旧工作区 detach、向目标 attach），失败则整体回滚；
6. 清理旧目录，并刷新投影缓存。

打开中的会话移动后无需刷新页面。

## 安装

```
# 直接从 GitHub 安装（web 式 profile）
dsh plugin --profile web add github:yuanxinbin520/dsh-session-cleaner

# 固定到某个发布 tag
dsh plugin --profile web add github:yuanxinbin520/dsh-session-cleaner#v0.1.0

# 走 HTTPS —— 网络屏蔽 SSH 22 端口时用这个
dsh plugin --profile web add https://github.com/yuanxinbin520/dsh-session-cleaner.git
```

若 `github:` 安装报 `ssh: connect to host github.com port 22: Connection refused`，改用上面的 HTTPS 形式，或把 SSH 改走 443 端口（在 `~/.ssh/config` 中加入）：

```
Host github.com
  HostName ssh.github.com
  Port 443
```

desktop profile 由 Electron 应用独占管理，命令行会拒绝；请用应用内的 **设置 → 插件** 安装，或让插件管理器执行 `install_bundle github:yuanxinbin520/dsh-session-cleaner`。安装后重启（客户端半只需刷新页面）即可生效。

要求：DSH `>= 0.2.0-rc.1`（在 `0.2.0-rc.2` 上验证），Node `>= 22.15`（使用内置 `node:zlib` 的 Zstandard API）——**无第三方依赖、无需构建**。

### 本地开发

源码目录即插件目录，改完刷新页面（客户端半）即生效：

```
dsh plugin --profile <name> add link:/absolute/path/to/dsh-session-cleaner
```

卸载：设置 → 插件 → `dsh-session-cleaner` → 卸载，随后删除 profile 中残留的 junction。

## 接口（宿主半）

宿主在 `ctx.webServer` 上注册 `/session-cleaner/api` 前缀路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/workspaces?sessionId=…` | 工作区列表 + 该会话当前所属工作区 |
| POST | `/move` | `{ sessionId, targetWorkspaceId }` |
| POST | `/delete` | `{ sessionId }` |

同源 `fetch`，无需额外鉴权头；按会话 id 串行化，避免同一会话并发操作。

## 开发与验证

```
npm run check                    # 两半的语法检查
node test/verify-artifacts.mjs   # 对真实日志做「解码→重编码→解码」字节级往返校验
node test/verify-ops.mjs         # 在临时 fixture 里跑删除/移动/损坏日志/路径安全
```

`test/verify-artifacts.mjs` 是保护移动操作的关键测试：DSH 的 `.jsonl.zstd` 是**逐批拼接的多帧**（实测一个 9.9 MB 日志含 7189 帧、解出 35.6 MB），任何只读第一帧的解码器都会把日志截成只剩头行。两套测试都自带 fixture：没有 DSH 安装时 ops 套件会自造 2001 帧的合成日志，因此 CI 无需 Harness 环境。

## 已知边界

- 删除当前正打开的会话：行会消失，界面可能停留在该会话的空视图，刷新页面即可。
- 投影缓存聚合文件若在宿主运行时被回写，孤立行可能重新出现；逐会话文件不受影响（应用关闭后清理最彻底）。
- 仅支持 `sessionPersistence` 暴露 `locate()` 的后端；没有 `locate` 时会明确报错而不是盲删。
- 未做批量操作（批量删除可用 session-manager 类插件的面板）。

## 许可

MIT，见 [LICENSE](LICENSE)。
