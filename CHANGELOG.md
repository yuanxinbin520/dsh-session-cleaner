# Changelog

## 0.2.1

- **新增：配置开关可以编辑**。每个开关多了「编辑」按钮，可改名称、说明和片段；改片段时
  `id` 与开关状态都保留，开关行按新片段重新推导，补丁块原地重写（用户手写行照旧不动）。
  新增 `POST /session-cleaner/api/switches/update { id, name?, description?, insert? }`，
  只传要改的字段即可。
- 「新增开关」表单补上「说明」字段（此前只能写进状态文件或走接口）。
- `test/verify-switches.mjs` 增加 8 条编辑断言（id/状态保留、片段替换、行重新推导、
  说明默认保留、用户行完整、未知 id 与无 id 片段被拒），共 36 条。

## 0.2.0

- **修复：配置开关页在 0.2.1 桌面运行时里不出现**。0.2.1 把「插件配置」搬出了设置页
  （设置 →「内置插件」只剩一个托管标签页的壳），因此 0.1.4 的 `settings.plugin.item`
  卡片在那个槽位里永远不会被渲染。现在改为注册到 `settings.plugins.tab`
  （`id: config-switches`、`order: 70`、标签「配置开关」），出现在
  设置 → 内置插件 →「插件列表」「插件市场」之后的标签行里；页面本体（开关列表、
  开启/关闭、查看片段、删除、新增）与四条 `/session-cleaner/api/switches*` 路由不变。
- 去掉对 `@deepseek-ai/schemastery` 的依赖与 settings 命名空间注册：0.2.x 的页面由
  `settings.plugins.tab` 承载，不再需要「Host 提供的命名空间」作为卡片 key
  （0.1.x 的卡片机制已无意义），插件因此变成 Host 侧零外部依赖。
- `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-settings`；
  `dshhub.capabilities.provides` 改为 `slot:settings.plugins.tab`。
- 新测试 `test/verify-client-tab.mjs`：在 `vm` 里执行真实客户端 bundle，断言只注册一个
  `settings.plugins.tab` 页、id/order/标签正确，且原有的会话菜单两行与确认对话框注册不变。
- 已在 0.2.1-rc.5 运行时上用独立 profile 实测：boot graph 收录该行、客户端 bundle 正常下发、
  `GET /session-cleaner/api/switches` 返回正确的 profile 与补丁路径。

## 0.1.4

- **新增：配置开关**。设置 → 插件 →「插件配置」里多一张卡片，把任意 patch 片段写进当前 profile
  的 `cordis.patch.yml` 并可热开关。开关落地方式是「常驻 `- insert:` 块 + 后置 `- id: <row>` +
  `disabled: true|false` 覆盖行」，依赖 profile 补丁层的 HMR（`patchReload: live`），约 1 秒内
  重新组合，不需要重启，运行中的会话工具集也会跟着变。
  - 新文件 `lib/switches.js`：零依赖开关引擎（块合成、幂等、原子写、时间戳备份、状态文件、
    片段校验与四类错误码）。
  - `lib/index.js`：注册 settings 命名空间 `config-switches`（卡片靠它出现），新增
    `GET /switches`、`POST /switches/{toggle,add,remove}`。
  - `lib/client.js`：`settings.plugin.item` 卡片，含开启/关闭、查看片段、删除、新增。
  - 新测试 `test/verify-switches.mjs`（27 条断言），并加入 `npm test`。
  - 内置示例开关 `DBX MCP 工具`：把 `@deepseek-ai/dsh-mcp-client` 挂到宿主层。
- 已有的会话删除 / 跨工作区移动行为不变（`verify-ops`、`verify-artifacts`、`verify-client-id` 全绿）。

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
