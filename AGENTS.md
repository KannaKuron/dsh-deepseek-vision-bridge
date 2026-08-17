# AGENTS.md

面向后续在本仓库继续开发的 Agent / 贡献者。读完再动手。

## 环境与工具

- 本机已安装 GitHub CLI(`gh`,位于 `/opt/homebrew/bin/gh`)且已完成认证:建仓、推送、开 PR、release 等 GitHub 操作**优先用 `gh`**,不要手动调 API 或让用户去网页点。
- 分发**只走 GitHub**(不发布 npm):安装命令 `dsh plugin --profile web add https://github.com/KannaKuron/dsh-deepseek-vision-bridge`;版本管理用 git tag + GitHub Release。将来若要上 npm,`npm version` + `npm publish` 即可,工程面已备好。
- 需要 GitHub 交互时优先使用 `gh`,而不是手动调 API 或让用户自己去网页操作。

## 项目一句话

`dsh-deepseek-vision-bridge`:DSH 插件,把 chat.deepseek.com 官网「识图模式」(非公开接口,逆向所得)桥接给纯文本模型 —— `deepseek_vision` 工具 + 会话内图片自动转写 + 设置页微信扫码/密码/userToken 登录。

## 目录地图

| 路径 | 作用 |
|---|---|
| `src/index.ts` | host 半:`/dsv/api/*` HTTP 路由、`deepseek_vision` 工具注册、`agent/pre-step` 图片→文字转写、`llm.resolveModelInfo` 能力补丁、`llm/stream` 兜底、credentials 持久化 |
| `src/worker.mjs` | 协议核心(纯 Node 子进程,每次 op 独立 spawn):PoW wasm、上传→fork→SSE 识图、微信扫码长轮询、会话 finally 删除 |
| `src/sha3.wasm` | 官网 PoW wasm 原件(DeepSeekHashV1,零 import);**不要反编译重写**——实测纯算法复刻与 wasm 答案不一致,必须跑原 wasm |
| `src/client/index.tsx` | client 半:设置页「DeepSeek 视觉」(React.createElement,无 JSX) |
| `dsh.plugin.json` | 插件注册表清单(id `dsh-external/dsh-deepseek-vision-bridge`) |
| `cordis.patch.yml` | `dsh plugin --profile <name> add` 官方安装通道的自动挂载声明 |
| `tsdown.config.ts` | host ESM + client 双通道 bundle(module-loader 注册形状,banner/footer 是关键,别乱动) |

## 常用命令

```bash
npm install --registry=https://registry.npmmirror.com --cache ./.npm-cache   # 装依赖(网络受限时)
npm run build    # tsdown 打包 → tsc 出类型 → 拷贝 worker.mjs / sha3.wasm 到 lib/
npm test         # node --test tests/smoke.mjs(8 项,含 2 项真实网络用例)
npm pack --dry-run --cache ./.npm-cache   # 发布前检查打包内容
```

改动后必须:`build` 通过 + `test` 全绿 + `npm pack --dry-run` 里 **lib/ 六件套齐全**(index.js、client.js、client-registry.js、worker.mjs、sha3.wasm、types/index.d.ts)。

### 构建脚本必须跨平台(Windows 用户在用)

- `scripts/*.mjs` 里**禁止 Unix-only 命令**(`rm -rf`、`cp`、`ln`…):用 `node:fs` 的 `rmSync/cpSync/mkdirSync`。
- 调 `node_modules/.bin` 下的本地 bin:Windows 下是 `.cmd` shim,且 Node 自 CVE-2024-27980 后拒绝无 shell 直跑 `.cmd`——按 `scripts/build.mjs` 的 `bin()/run()` 模式写(IS_WIN 时拼 `.cmd` 路径 + `shell: true`)。
- 探测 devDependencies 是否存在时,`.bin/tsdown` 与 `.bin/tsdown.cmd` 都要查。

## 协议速查(逆向结论,2026-08 实测)

- 登录:微信扫码 = `open.weixin.qq.com/connect/qrConnect`(生产 appid `wx932d4fdaf46d5611`)→ 长轮询 `long.open.weixin.qq.com/connect/l/qrconnect`(408 等待/404 已扫/405 确认带 code/402 过期/403 取消)→ 官网 `/api/v0/users/oauth/wechat/callback` 307 带 nonce → `/api/v0/users/oauth/get_token`。密码 = `/api/v0/users/login`。
- 识图链:`create_pow_challenge`(需 Bearer!)→ `file/upload_file`(multipart + PoW)→ `file/fork_file_task {to_model_type:"vision"}` → `chat_session/create` → `chat/completion`(**`model_type:"vision"` 必带**,SSE)→ `chat_session/delete`(finally 全路径)。
- PoW 头:`x-ds-pow-response` = base64({algorithm,challenge,salt,answer,signature,target_path});wasm 导出 `wasm_solve(retptr, ch_ptr, ch_len, pfx_ptr, pfx_len, difficulty)`,prefix = `salt_expireAt_`。
- 请求需带浏览器级 UA(裸 curl 会被华为 WAF 429)。
- 接口随时可能变:失败时先看 worker 返回的 `error` 字段(已带 HTTP 状态与响应体片段)。

## 安全红线

- **绝不提交任何真实 token / 凭据 / 账号信息**。登录态只存 DSH 官方 credentials 服务(`~/.dsh/.credentials.yaml`,ref `DSV_USER_TOKEN`),代码里只出现 ref 名。
- 仓库里的 `wx932d4fdaf46d5611` 是 DeepSeek 官网前端 JS 里的公开 appid,不算机密;UA、接口路径同理。
- `.npmrc`、`.env`、`*.tgz`、`node_modules/`、`lib/`、`.npm-cache/` 一律不进 git(见 `.gitignore`;发布前确认 `npm pack --dry-run` 无多余文件)。
- HTTP 路由只信 loopback Host(`isTrustedRequest`);如要放宽必须走 DSH 的信任源,不要自己加白名单。
- 涉及用户图片:只经 DSH attachments 服务与内存管道,不落任何临时盘上副本。

## 沙箱约定

- 当前目录若作为临时沙箱使用:任务中产生的临时文件(脚本、抓包、测试图)完成后**主动清理**;只删本次任务自己创建的产物,不误删用户已有文件。
- 提交信息用英文一行式(conventional commits 风格)。

## 发布 checklist(GitHub-only)

1. `npm run build && npm test` 全绿
2. 版本号:`npm version patch|minor`(协议无破坏性改动用 patch,新增能力用 minor)
3. `git push --tags`
4. `gh release create <tag>`(notes 里带安装命令与变更摘要)
5. 用户侧更新 = 重跑安装命令(拉最新 master;钉 tag 安装则拉对应 tag)

### 同版本内补提交后,更新已有 release(不产生 untagged 草稿)

**不要**先删远端 tag 再推新 tag(会把 release 打成 untagged 草稿)。正确顺序:

```bash
git tag -f v0.1.0 -m "..."     # 本地强制重钉到新 commit
git push -f origin v0.1.0      # force-push,release 保持挂在 tag 名上
gh release edit v0.1.0 --notes "..."   # 只改 notes
# 若不慎变成 draft:gh release edit v0.1.0 --draft=false
```

验证:`gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object.sha'` 是 annotated tag 对象的 sha,**不是 commit**;解引用用 `git rev-parse <tag>^{commit}` 或 API 的 `git/tags/<sha>` 再取 `.object.sha`。
