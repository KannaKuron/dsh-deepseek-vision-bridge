# dsh-deepseek-vision-bridge

> 给纯文本模型装上眼睛 —— 把 [chat.deepseek.com](https://chat.deepseek.com) 官网「识图模式」桥接进 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh)。

DSH 的后端模型常常没有视觉能力,而 DeepSeek 官网却有内测中的真·多模态识图模式。本插件把官网识图的完整链路(逆向所得:PoW 工作量证明 → 图片上传 → fork 到视觉模型 → 流式补全)封装成 DSH 的能力:

- **🔧 `deepseek_vision` 模型工具** — 传入图片路径或 URL,返回结构化文字描述(整体场景 / 图中全部文字逐字转写 / 关键数据与报错 / 推断上下文),纯文本模型当轮即可回答关于图片的问题
- **🖼️ 会话内直接发图** — 在 DSH 输入框粘贴 / 拖入图片发送,插件把图片换成带原图稳定路径的占位卡(会话记录里原图照常显示);模型结合你的意图自己决定何时、以什么问题调用视觉工具分析,后续追问随时可再看原图
- **📱 设置页登录** — 微信扫码(无头长轮询,与官网同款链路)/ 邮箱手机号密码 / 粘贴 userToken 三种方式;登录态经官方 credentials 服务存于 `~/.dsh/.credentials.yaml`,DSH 重启自动恢复
- **🧹 用后即删** — 每次识图在官网创建的临时会话在 finally 中删除(成功 / 失败 / 超时全路径),不会污染你网页端的会话列表

## 安装

直接从 GitHub 安装(暂未发布 npm):

```bash
dsh plugin --profile web add KannaKuron/dsh-deepseek-vision-bridge
# 或完整地址
dsh plugin --profile web add https://github.com/KannaKuron/dsh-deepseek-vision-bridge
```

装完**硬刷新浏览器**(Cmd/Ctrl+Shift+R)。host 半更新才需要重启 DSH,client 改动热刷新即可。

也可以用 npx 免安装:

```bash
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add https://github.com/KannaKuron/dsh-deepseek-vision-bridge
```

> 更新:插件市场页对 git 安装的插件自动对比锁文件 commit 与 GitHub HEAD,有新版本会直接出现「更新」按钮,点击即可(内部重新解析 HEAD 并现场构建)。注意:更新检测依赖 api.github.com 连通,GitHub 故障/限流期间检测会静默失败(显示"已是最新"但实际有新版),可访问 `/dsh-market/updates?force=1` 强制刷新确认。host 半变更更新后需重启 DSH。命令行等价操作:`dsh plugin --profile web add github:KannaKuron/dsh-deepseek-vision-bridge`(重新解析 HEAD)。安装/更新均通过 `prepare` 现场构建,macOS/Linux/Windows 支持。

<details>
<summary><b>安装被 pnpm 拦下时(供应链保护 / 构建脚本放行)</b></summary>

首次从 GitHub 安装会经过 pnpm 的两道保护,各需要放行一次:

1. **`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`**(与本项目无关):profile 里已有插件的新版本处于发布后 24h 冷静期。把报错列出的包名加进 `~/.dsh/profiles/web/pnpm-workspace.yaml`:
   ```yaml
   minimumReleaseAgeExclude:
     - dsh-better-sidebar
     - dshmarket
     # …报错里列出的其他包
   ```
2. **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`**(本项目需要现场构建):按报错给出的精确 key 加入同文件:
   ```yaml
   allowBuilds:
     'dsh-deepseek-vision-bridge@git+https://github.com/KannaKuron/dsh-deepseek-vision-bridge.git': true
   ```

两处都改完后**重跑同一条安装命令**即可。第二次起不再触发(已装包有缓存)。

</details>

## 使用

1. 打开 **设置 → DeepSeek 视觉**,选一种方式登录(推荐微信扫码)
2. 直接在会话输入框发图,或把图片路径丢给模型让它调 `deepseek_vision`
3. 可在设置页点「识图测试」验证链路

## 工作原理

```
┌─────────────┐   图片(路径/URL/会话附件)   ┌──────────────────┐
│  DSH 会话    │ ─────────────────────────▶ │  host: 桥插件      │
│ (纯文本模型) │ ◀───────────────────────── │  (deepseek_vision │
└─────────────┘   文字描述(场景/转写/数据)   │   + pre-step 转写) │
                                            └───────┬──────────┘
                                                    │ 每次 op spawn 纯 Node worker
                                                    ▼
                                   chat.deepseek.com(逆向协议)
                             PoW wasm(官方 DeepSeekHashV1)→ upload_file
                             → fork_file_task(vision)→ chat/completion
                             (SSE, model_type=vision)→ chat_session/delete
```

- **登录**:微信扫码走 微信开放平台二维码 → 官网服务端换码 → `oauth/get_token`;密码走 `/api/v0/users/login`。token 通过 DSH 官方 `credentials` 服务持久化(ref `DSV_USER_TOKEN`)
- **识图**:worker(纯 Node 子进程)完成全部协议工作,内嵌官网 PoW wasm(约 26KB,零依赖)
- **会话内发图**:官方 `agent/pre-step` waterfall 把 image 块替换为识图文本(durable log 不动);`llm/stream` 作为最后防线对纯文本模型做占位替换

## ⚠️ 重要声明

- 本插件调用的是 **chat.deepseek.com 的非官方网页接口**(逆向所得),不是公开 API。接口变更可能导致失效;请自担风险,遵守 DeepSeek 服务条款
- 你的账号在 DeepSeek 侧产生的用量、风控(如验证码频控)由你的账号自身承担
- PoW wasm 为官网原始文件的内嵌副本,仅用于通过其反爬校验

<details>
<summary><b>卸载与凭据清理</b></summary>

插件市场页「卸载」会**自动清除**存储的 DeepSeek token(卸载流程先删包再卸载插件,插件检测到包目录消失即 unset `DSV_USER_TOKEN`)。

命令行卸载(`dsh plugin --profile web remove dsh-deepseek-vision-bridge`)不经过插件代码,token 会残留;如需彻底清除,任选其一:

```bash
# 方式一:编辑 ~/.dsh/.credentials.yaml,删除 DSV_USER_TOKEN 行
# 方式二(下次再装市场版后用市场页卸载,自动清理)
```

</details>

## 从源码构建

```bash
git clone https://github.com/KannaKuron/dsh-deepseek-vision-bridge.git
cd dsh-deepseek-vision-bridge
npm install
npm run build   # tsc 类型 + tsdown 打包 + 拷贝 worker/wasm
npm test        # 冒烟测试(worker 协议面 + 产物一致性)
```

## License

[MIT](./LICENSE)
