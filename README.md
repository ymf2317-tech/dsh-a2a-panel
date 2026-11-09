# dsh-a2a-panel

> **给 AI 的提示**：这份 README 主要是写给你（读它的 AI）看的，不是给人类从头读完的。
> 基础已经搭好——host 反代、路径 shim、登录跳转兜底都做完了，你不需要重写架构。
> 你要做的通常只有三件事：照着「配置」把 `apiBase` 指向用户的 Agent2API 地址、
> 按用户口味微调 `lib/client.js` 里的 `CSS`、用 `scripts/test-a2a-panel-proxy.mjs` 验证链路。
> 遇到问题先读「四个坑」那一节，别急着改反代逻辑。

在 DeepSeek Harness 的侧边栏里直接打开 **Agent2API 的原版管理面板**。不是重画一个只读看板，
而是把整套网页同源反代进来，用 iframe 跑原版页面：报表、账号、签到、路由、模型管理、
网关 Key、请求日志、定时任务——按钮和跳转全是你熟悉的那个。

## 前置条件：必须有 Agent2API

**这个插件是"面板搬运工"，不是网关。** 它不含任何模型、账号、密钥或转发能力，
必须配合一个已经在运行的 [Agent2API](https://github.com/aimod-cc/Agent2API) 使用：

```
                    ┌──────────────────────────────────────────┐
   你的手机/浏览器 ──▶│ DSH Web（https，可走 tailnet / 内网穿透） │
                    │   └ dsh-a2a-panel 视图（iframe）          │
                    │        └ host 反代 /a2a-panel/ui/*        │
                    └───────────────────┬──────────────────────┘
                                        │ 本机 127.0.0.1
                                        ▼
                            Agent2API（默认 :3065）
                              ├ /ui  原版面板（HTML/JS/CSS）
                              └ /api 面板接口
```

- 没有 Agent2API：插件打开就是 502，没有意义。
- Agent2API 跑在别的机器上：把 `apiBase` 改成可访问地址即可（host 侧发请求，不需要浏览器能直连）。
- **不需要**在本机另开一个"面板端口"，也不需要把 3065 暴露到公网。

## 它解决的问题

1. **mixed content**：DSH 常以 `https://<域名>/` 打开，页面里再嵌 `http://<ip>:3065` 会被浏览器直接拦掉，
   手机上必然白屏。反代之后是 `https://<域名>/a2a-panel/ui/...`，同域同协议。
2. **绝对路径**：面板前端把接口写成 `/api/xxx`，挂在子路径下会打到 DSH 自己身上。反代在 HTML 里
   注入 shim，把 `fetch` / `XMLHttpRequest` / `EventSource` / `location.replace|assign` 的绝对路径
   改写到前缀下，并补 `<base>` 让相对资源（`app.js`、`m/mobile.js`）正确解析。
3. **跳转丢前缀**：面板 302 到 `/login`、登录后跳 `/`，这些在前缀下会跳出 iframe。反代改写
   `Location` 头；`location.href=` 这类脚本硬跳没法 hook，由前端在 `load` 事件里把**目标路径整体前缀化**后重载。
4. **cookie 污染**：登录态 cookie 的 `Path` 被收窄到 `/a2a-panel/ui/`，不影响 DSH 自己的会话。

## 四个坑（改代码前先看）

| 现象 | 根因 | 现在的处理 |
|---|---|---|
| 打开一片空白，但点「新窗口」能看到 | DSH 主视图容器不保证有确定高度，`height:100%` 会算成 0 | shell 给 `min-height: calc(100dvh - 96px)` 兜底 |
| 冷启动白屏几秒 | 面板首屏要拉 2MB+ JS 和统计数据 | 加了转圈 +「正在加载…」，`onLoad` 后撤掉 |
| 登录后白屏 / 变回 DSH 主界面 | 面板用 `location.href='/'` 硬跳，跳出了反代前缀 | `onLoad` 检测 pathname 不在前缀内，把**跳去的那个路径加前缀**再加载（最多 8 次） |
| 移动版提示「会话已过期」，点「去登录」没反应 | 早期兜底逻辑"越界就退回入口页"，导致 入口→弹过期→去登录→被拉回入口 的死循环 | 同上：跳 `/login` 就变成 `/a2a-panel/ui/login`，登录流程闭合成环；窄屏登录完回 `/m/` |

## 安装

```bash
# 1) 放到你的 DSH profile 能看见的地方
git clone https://github.com/<you>/dsh-a2a-panel.git D:/dsh-workspace/packages/dsh-a2a-panel

# 2) 在 profile 的 package.json 里登记（link: 本地目录即可）
#    dependencies:  "dsh-a2a-panel": "link:D:/dsh-workspace/packages/dsh-a2a-panel"
#    dsh.profile.bundles: ["dsh-a2a-panel", ...]

# 3) 建软链，避免 pnpm install 前模块解析失败
#    <profile>/node_modules/dsh-a2a-panel -> 上面的目录

# 4) 改完 host 侧代码要重启 DSH Web；只改 lib/client.js 则关开插件 + 硬刷即可
```

## 配置（`cordis.patch.yml`）

| 键 | 说明 |
|---|---|
| `apiBase` | Agent2API 地址，默认 `http://127.0.0.1:3065` |
| `gatewayKey` | 可选。面板的部分 `/api/*`（accounts、keys、logs）接受网关 Key `sk-a2a-...`；**优先用环境变量 `A2A_GATEWAY_KEY`**，不要把真实 Key 写进仓库 |
| `timeoutMs` | 单次上游请求超时，默认 20000（首屏要拉几 MB，留足） |

> 面板 UI 的登录态仍由 Agent2API 自己的管理员账号决定：首次在 iframe 里登录一次，之后 cookie 保持。

## 端点

- `GET /a2a-panel/ui/*` — 原版面板整站（HTML 会被注入 `<base>` + shim）
- `GET /a2a-panel/ui/m/*` — 手机版面板（容器宽度 < 820px 时自动切换过去）
- `GET /a2a-panel/api/snapshot` — 聚合快照（3 秒缓存，备用）
- `GET /a2a-panel/api/health` — 轻量探活

## 自测

```bash
node scripts/test-a2a-panel-proxy.mjs          # 起一个临时 3099，把 host 半侧挂上去
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3099/a2a-panel/ui/login   # 期望 200
curl -s -D - -o /dev/null http://127.0.0.1:3099/a2a-panel/ui/ | grep -i location    # 期望 302 -> /a2a-panel/ui/login
```

不碰正在运行的 DSH，验证的是同一份 `lib/index.js`。

## 已知限制

- 面板升级后若新增了别的绝对路径请求方式（例如 WebSocket、service worker），需要同步扩充 `lib/index.js` 的 `SHIM`。
- 窄屏用的是上游自带移动版 `/m/`，它那张蓝色卡片在 424px 左右三列偏挤，属于上游排版，未改。
- 反代是"原样搬运"，不做鉴权增强：谁能打开 DSH，谁就能操作面板。

## License

本插件 **MIT**。

它通过 HTTP 反代一个**用户自己安装并运行的** [Agent2API](https://github.com/aimod-cc/Agent2API)
（上游为 **AGPL-3.0**），不包含、不链接、不打包上游任何代码；上游面板文件始终由 Agent2API 自己提供。
若你要把上游面板文件随仓库一起分发，请遵守 AGPL-3.0。
