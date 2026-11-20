# AtoZ 插件中心

AtoZ 桌面应用的插件（工具箱工具 / 页面 / 仪表盘小组件）源码与发行仓库。

推送 `vX.Y.Z` tag 后由 GitHub Actions 自动打包、发布到 GitHub Release，并把索引
`registry.json` 回写到 `main`、镜像到 Gitee Release。应用内「工具箱 → 获取工具」直接读取该索引。

---

## 目录结构

```
my-dash-plugins/
├── plugins/                     # 插件源码，一个子目录一个插件
│   ├── hello-tool/
│   │   ├── plugin.json
│   │   └── index.js
│   └── notes-stats/
├── scripts/
│   ├── build-tools.mjs          # 校验 + 打包 + 生成 registry.json
│   └── publish-gitee.mjs        # 镜像到 Gitee Release
├── .github/workflows/release.yml
├── registry.json                # 索引（CI 回写，勿手改）
└── dist/                        # 打包产物（gitignored）
```

## 新增一个插件

1. 复制 `plugins/hello-tool` 为 `plugins/<你的插件id>`，改 `plugin.json`：

```json
{
  "id": "my-tool",
  "name": "我的工具",
  "version": "0.1.0",
  "description": "一句话说明",
  "category": "文本",
  "main": "index.js",
  "permissions": ["storage"]
}
```

`id` 必须匹配 `^[a-z0-9][a-z0-9-]{1,63}$`，且**发布后不要再改**——升级靠 id 覆盖安装。

2. 写入口 `index.js`，导出 `activate(ctx)`，用 `ctx.registerTool / registerPage / registerWidget`
   注册能力。Vue 从 `ctx.vue` 取、Element Plus 从 `ctx.ui` 取，**不要裸 import**。

3. 本地校验：

```bash
npm install
npm run check        # 校验清单、入口、体积、符号链接
npm run pack         # 产物在 dist/（zip + registry.json + release-notes.md）
```

4. 本地调试：把插件目录放到主应用的 `plugins-dev/` 下（该目录仅 dev 模式扫描），
   主应用「设置 → 插件 → 重载全部」即可加载。也可以整仓克隆过去：

```bash
git clone <本仓库地址> ../myDash/plugins-dev
```

## 发布

```bash
# 改完 plugin.json 的 version 后
git tag -a v0.1.0 -m "插件中心 0.1.0"
git push origin v0.1.0        # Gitee
git push github v0.1.0        # GitHub（流水线跑在这里）
```

流水线会：

1. `npm ci` → `node scripts/build-tools.mjs --tag v0.1.0 --registry registry.json`
2. 创建/复用 GitHub Release，上传 `dist/*.zip`（`--clobber`，可重跑）
3. 把 `registry.json` 提交回 `main`
4. 若配置了 `GITEE_TOKEN`：推 `main` 与 tag 到 Gitee，并上传 zip 到 Gitee Release

也可以手动运行 workflow，填已存在的 tag，或用 `plugins` 输入只发某个插件。

## 索引格式

```json
[
  {
    "id": "hello-tool",
    "name": "Hello 工具示例",
    "version": "0.1.0",
    "description": "…",
    "category": "其他",
    "downloadUrl": "https://gitee.com/yukai1998/my-dash-plugins/releases/download/v0.1.0/hello-tool-0.1.0.zip",
    "mirrors": ["https://github.com/cocYu/my-dash-plugins/releases/download/v0.1.0/hello-tool-0.1.0.zip"],
    "sha256": "8dd364b8…",
    "size": 1294
  }
]
```

- 默认 **Gitee 主源、GitHub 镜像**（`--primary github` 可反转），任一可用即可安装
- `sha256` 必填：应用下载后校验，不匹配直接拒绝
- 应用侧索引还有多源回退：Gitee raw → jsDelivr → GitHub raw

## 首次配置（推到远程前）

1. 在 Gitee / GitHub 各建一个**空仓库** `my-dash-plugins`（不要初始化 README）
2. 关联远程并推送：

```bash
git remote add origin git@gitee.com:yukai1998/my-dash-plugins.git
git remote add github https://github.com/cocYu/my-dash-plugins.git
git push -u origin main
git push github main
```

3. GitHub 仓库 **Settings → Secrets and variables → Actions** 添加 `GITEE_TOKEN`
   （Gitee 私人令牌，勾 `projects`；不配则跳过 Gitee 镜像）
4. 如果仓库路径与默认不同，在 GitHub **Variables** 里加 `GITEE_REPO=owner/repo`，
   或改 `scripts/build-tools.mjs` 顶部的默认值
5. 推 `v0.1.0` tag 触发首次发布

## 安全边界

插件运行在 AtoZ 渲染层主世界（与主应用同一 JS 上下文），`permissions` 只是声明式约束，**不是沙箱**。
所以本仓库的写权限等同于所有用户的执行权限：

- 只合并可信的 PR，重点看入口有没有 `eval`、动态远程脚本、越权访问
- 包体积上限 10MB（脚本强制），避免插件随数据同步膨胀
- `sha256` 防包被篡改，但防不了索引被换掉；需要更强保证时可加 registry 签名（Ed25519 待做）

## 相关文档

- 主应用仓库：`docs/plugin-registry.md`（应用侧实现与索引回退逻辑）
- 应用内：设置 → 插件 → 插件开发文档（PluginContext API、权限模型、FAQ）
