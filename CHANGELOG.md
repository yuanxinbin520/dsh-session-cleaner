# Changelog

## 0.1.3

- **修复：装了这个插件后 DSH 无法启动**。`lib/client.js` 的
  `window.__ModuleLoader__.load({ id })` 仍是旧的不带 scope 的 `dsh-session-cleaner`，
  而 DSH 的客户端模块系统按 **package.json 的 `name`** 索引 boot graph 每一行并按该键查找
  工厂：id 不匹配时这一行永远注册不上，`arrive()` 会回退到该行自己的 URL 再执行一次同一个
  bundle，于是第二次注册抛出
  `client-modules: duplicate factory registration for "dsh-session-cleaner"`，
  整个 Web 启动以 `web boot: 1 entry did not activate` 收尾（桌面端弹致命错误/恢复对话框）。
  0.1.1 把包名改成 scoped 时就已经漏改这里，0.1.2 改名后同样漏改，因此 0.1.1/0.1.2 均受影响。
  现在 `id` 与包名逐字一致：`@beiwen/dsh-session-cleaner`。
- 新增 `test/verify-client-id.mjs` 并纳入 `npm test`：断言 id 等于包名、只注册一次、
  `cordis.patch.yml` 的 `name` 同步、`require()` 只用 shell 的静态 seed 模块，防止再次改名漏改。

## 0.1.2

- 包名改为 **`@beiwen/dsh-session-cleaner`**：npm 只允许发布到自己用户名或自己组织的 scope 下，而本项目的
  npm 账号是 `beiwen`（`@yuanxinbin520` 那个 scope 不属于该账号，发布会被 403 拒绝）。
  `cordis.patch.yml` 的 `name` 同步更新。功能无变化。
- 注意：本次改名漏更新了 `lib/client.js` 的模块 id，导致 0.1.2 装上后 DSH 无法启动，请在 0.1.3 修复。

## 0.1.1

- 包名改为 **scoped** `@yuanxinbin520/dsh-session-cleaner`（npm 上不带 scope 的 `dsh-session-cleaner`
  已被无关包占用），`cordis.patch.yml` 的 `name` 同步为 scoped 名，并加上 `publishConfig.access: public`。
- README 补充 npm 安装方式、Hub/示例目录的收录方式，以及 GitHub 不可达时的镜像源与 git 证书处理。
- 功能无变化。

## 0.1.0

首个版本，只做两件事，都挂在会话行「…」菜单底部（内置 pin/rename/fork/archive 之后）：

- **彻底删除会话**：确认框 → 拆除 live 会话/agent → 清理工作区归属与归档、收藏标记 →
  删除会话日志目录（v4/v3/v2/v1 全代次）→ 清理投影缓存（逐会话文件 + 旧版聚合文件行，写 `.bak`）。
  安全边界：只有工件头行能证明 id 匹配的目录才会被删；目录必须是 `<sessions>/<项目>/<会话>`
  且两层都不能是符号链接；会话标识做路径穿越校验；日志截断时仍可删除（只读头帧定位）。
- **移动到其他工作区**：重写头行 `cwd`、把代次与文件名的版本对齐、原子发布（失败回滚原文件）、
  运行中的会话原地重绑不销毁、交换工作区归属、清理旧目录并刷新投影缓存。

实现要点：DSH 的 `.jsonl.zstd` 是逐批拼接的**多帧**日志（实测 9.9 MB / 7189 帧 / 解出 35.6 MB），
因此自带帧边界遍历的编解码（含 checksum、RLE 块、保留位校验），并用真实日志做字节级往返验证。
