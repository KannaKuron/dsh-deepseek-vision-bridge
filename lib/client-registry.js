window.__ModuleLoader__.load({
	id: "dsh-external/dsh-deepseek-vision-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/index.tsx
		/**
		* dsh-deepseek-vision-bridge — client half.
		*
		* Contributes the "DeepSeek 视觉" settings section: login state card,
		* WeChat QR login (headless long-poll through the host's HTTP route),
		* password login, and a userToken paste fallback. Talks to the host half
		* exclusively through the same-origin `/dsv/api/*` JSON routes.
		*/
		/** Services required before mounting. */
		const inject = ["slots"];
		async function api(op, body = {}) {
			const resp = await fetch(`/dsv/api/${op}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					op,
					...body
				})
			});
			if (!resp.ok) {
				let detail = `HTTP ${resp.status}`;
				try {
					const j = await resp.json();
					if (j && j.error) detail = j.error;
				} catch {}
				throw new Error(detail);
			}
			return resp.json();
		}
		const CSS = `
.dsv-page{display:flex;flex-direction:column;gap:16px;max-width:640px;font-size:14px;line-height:1.6;}
.dsv-card{border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;}
.dsv-title{font-weight:600;font-size:15px;}
.dsv-muted{opacity:.7;font-size:12.5px;}
.dsv-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.dsv-input{flex:1;min-width:160px;padding:7px 10px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:transparent;color:inherit;font-size:13px;}
.dsv-btn{padding:7px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;font-size:13px;}
.dsv-btn:hover{opacity:.8;}
.dsv-btn:disabled{opacity:.45;cursor:default;}
.dsv-tabs{display:flex;gap:6px;flex-wrap:wrap;}
.dsv-tab{padding:6px 12px;border-radius:8px;cursor:pointer;border:1px solid transparent;font-size:13px;opacity:.75;}
.dsv-tab--on{border-color:rgba(128,128,128,.45);opacity:1;}
.dsv-ok{color:#2e9e5b;}
.dsv-err{color:#d05656;}
.dsv-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:rgba(128,128,128,.12);padding:2px 6px;border-radius:5px;word-break:break-all;}
.dsv-ta{width:100%;box-sizing:border-box;min-height:72px;padding:8px 10px;border:1px solid rgba(128,128,128,.4);border-radius:8px;background:transparent;color:inherit;font-size:12px;font-family:ui-monospace,Menlo,monospace;resize:vertical;}
a.dsv-link{color:inherit;text-decoration:underline;}
.dsv-qrwrap{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px 0;}
.dsv-qr{width:200px;height:200px;border:1px solid rgba(128,128,128,.3);border-radius:10px;background:#fff;padding:8px;box-sizing:border-box;}
`;
		let styleEl = null;
		function ensureStyles() {
			if (styleEl) return;
			styleEl = document.createElement("style");
			styleEl.setAttribute("data-plugin", "dsh-deepseek-vision-bridge");
			styleEl.textContent = CSS;
			document.head.appendChild(styleEl);
		}
		function DsvSettings() {
			const h = react.createElement;
			const [status, setStatus] = (0, react.useState)({
				loading: true,
				loggedIn: false,
				account: null
			});
			const [mode, setMode] = (0, react.useState)("wechat");
			const [account, setAccount] = (0, react.useState)("");
			const [areaCode, setAreaCode] = (0, react.useState)("+86");
			const [password, setPassword] = (0, react.useState)("");
			const [tokenText, setTokenText] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)(null);
			const [wxUuid, setWxUuid] = (0, react.useState)(null);
			const [wxMsg, setWxMsg] = (0, react.useState)(null);
			const refresh = (0, react.useCallback)(async () => {
				setStatus({
					loading: true,
					loggedIn: false,
					account: null
				});
				try {
					const s = await api("status");
					setStatus({
						loading: false,
						loggedIn: !!s.loggedIn,
						account: s.account ?? null
					});
				} catch (e) {
					setStatus({
						loading: false,
						loggedIn: false,
						account: null
					});
				}
			}, []);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			const run = (fn) => {
				if (busy) return;
				setBusy(true);
				setMsg(null);
				fn().catch((e) => setMsg({
					ok: false,
					text: e instanceof Error ? e.message : String(e)
				})).finally(() => setBusy(false));
			};
			const doLogin = () => run(async () => {
				const r = await api("login", {
					email: account.includes("@") ? account : void 0,
					mobile: account.includes("@") ? void 0 : account,
					areaCode,
					password
				});
				if (r.ok) {
					setMsg({
						ok: true,
						text: "登录成功"
					});
					setPassword("");
					await refresh();
				} else setMsg({
					ok: false,
					text: `登录失败:${r.error || "未知错误"}`
				});
			});
			const doToken = () => run(async () => {
				const r = await api("token", { token: tokenText });
				if (r.ok) {
					setMsg({
						ok: true,
						text: "Token 有效,已保存"
					});
					setTokenText("");
					await refresh();
				} else setMsg({
					ok: false,
					text: `Token 校验失败:${r.error || "无效"}`
				});
			});
			const doLogout = () => run(async () => {
				await api("logout");
				setWxUuid(null);
				setWxMsg(null);
				await refresh();
			});
			const doTest = () => run(async () => {
				const r = await api("analyze", {
					images: [{ url: "https://cdn.deepseek.com/platform/service_wechat.jpg" }],
					prompt: "用一句话说明这张图的内容。"
				});
				if (r.ok) setMsg({
					ok: true,
					text: `识图测试成功:${(r.text || "").slice(0, 120)}`
				});
				else setMsg({
					ok: false,
					text: `识图测试失败:${r.error || ""}`
				});
			});
			const genQr = () => run(async () => {
				setWxMsg(null);
				const r = await api("wxqr");
				if (r.ok && r.uuid) {
					setWxUuid(r.uuid);
					setWxMsg("请用微信扫码并在手机上确认");
				} else setWxMsg(`生成二维码失败:${r.error || "未知错误"}`);
			});
			(0, react.useEffect)(() => {
				if (!wxUuid) return void 0;
				let alive = true;
				(async () => {
					let last = 404;
					let fails = 0;
					while (alive) {
						let r = null;
						try {
							r = await api("wxpoll", {
								uuid: wxUuid,
								last
							});
						} catch {
							r = null;
						}
						if (!alive) return;
						if (!r || !r.ok) {
							fails++;
							if (fails >= 3) {
								setWxMsg("轮询连接失败,请刷新二维码重试");
								return;
							}
							continue;
						}
						fails = 0;
						const ec = r.errcode ?? 0;
						last = ec;
						if (ec === 408) continue;
						if (ec === 404) {
							setWxMsg("已扫码,请在手机上确认登录");
							continue;
						}
						if (ec === 405 && r.code) {
							setWxMsg("授权成功,正在换取登录态…");
							let lr = null;
							try {
								lr = await api("wxlogin", { code: r.code });
							} catch {
								lr = null;
							}
							if (!alive) return;
							if (lr && lr.ok) {
								setWxMsg("微信扫码登录成功");
								await refresh();
								return;
							}
							setWxMsg(`登录失败:${lr && lr.error || "未知错误"},请刷新二维码重试`);
							return;
						}
						if (ec === 403) {
							setWxMsg("已在手机上取消,请刷新二维码");
							return;
						}
						if (ec === 402) {
							setWxMsg("二维码已过期,请刷新");
							return;
						}
						setWxMsg(`状态异常(errcode=${ec}),请刷新二维码`);
						return;
					}
				})();
				return () => {
					alive = false;
				};
			}, [wxUuid, refresh]);
			const statusLine = status.loading ? h("span", { className: "dsv-muted" }, "检查登录状态…") : status.loggedIn ? h("span", { className: "dsv-ok" }, `已登录:${status.account && (status.account.email || status.account.mobile) || "未知账号"}(登录态由 DSH credentials 服务保管于 ~/.dsh/.credentials.yaml,重启自动恢复;设置页退出登录即清除)`) : h("span", { className: "dsv-err" }, "未登录 — 识图工具暂不可用");
			const tabs = h("div", { className: "dsv-tabs" }, h("div", {
				className: `dsv-tab${mode === "wechat" ? " dsv-tab--on" : ""}`,
				onClick: () => setMode("wechat")
			}, "微信扫码登录"), h("div", {
				className: `dsv-tab${mode === "password" ? " dsv-tab--on" : ""}`,
				onClick: () => setMode("password")
			}, "账号密码"), h("div", {
				className: `dsv-tab${mode === "token" ? " dsv-tab--on" : ""}`,
				onClick: () => setMode("token")
			}, "粘贴 userToken"));
			const wechatPane = h("div", {
				className: "dsv-card",
				key: "wx",
				style: {
					border: "none",
					padding: 0
				}
			}, wxUuid ? h("div", { className: "dsv-qrwrap" }, h("img", {
				className: "dsv-qr",
				src: `https://open.weixin.qq.com/connect/qrcode/${wxUuid}`,
				alt: "微信登录二维码"
			}), wxMsg ? h("div", null, wxMsg) : null, h("div", { className: "dsv-row" }, h("button", {
				className: "dsv-btn",
				onClick: genQr,
				disabled: busy
			}, "刷新二维码"))) : h("div", { className: "dsv-qrwrap" }, h("div", { className: "dsv-muted" }, "点击下方按钮生成微信登录二维码,手机 DeepSeek/微信扫码确认后自动完成登录。"), wxMsg ? h("div", null, wxMsg) : null, h("div", { className: "dsv-row" }, h("button", {
				className: "dsv-btn",
				onClick: genQr,
				disabled: busy
			}, busy ? "生成中…" : "生成二维码"))));
			const passwordPane = h("div", {
				className: "dsv-card",
				key: "pw",
				style: {
					border: "none",
					padding: 0
				}
			}, h("div", { className: "dsv-row" }, h("input", {
				className: "dsv-input",
				placeholder: "邮箱或手机号",
				value: account,
				onChange: (e) => setAccount(e.target.value)
			}), !account.includes("@") ? h("input", {
				className: "dsv-input",
				style: {
					maxWidth: 90,
					minWidth: 70,
					flex: "0 0 auto"
				},
				placeholder: "+86",
				value: areaCode,
				onChange: (e) => setAreaCode(e.target.value)
			}) : null), h("input", {
				className: "dsv-input",
				type: "password",
				placeholder: "密码",
				value: password,
				onChange: (e) => setPassword(e.target.value)
			}), h("div", { className: "dsv-row" }, h("button", {
				className: "dsv-btn",
				onClick: doLogin,
				disabled: busy || !account || !password
			}, busy ? "登录中…" : "登录")), h("div", { className: "dsv-muted" }, "走 chat.deepseek.com 官网登录接口;若触发官网人机验证/风控,请用微信扫码或 userToken 方式。"));
			const tokenPane = h("div", {
				className: "dsv-card",
				key: "tk",
				style: {
					border: "none",
					padding: 0
				}
			}, h("textarea", {
				className: "dsv-ta",
				placeholder: "粘贴 64 位 userToken…",
				value: tokenText,
				onChange: (e) => setTokenText(e.target.value)
			}), h("div", { className: "dsv-row" }, h("button", {
				className: "dsv-btn",
				onClick: doToken,
				disabled: busy || !tokenText.trim()
			}, busy ? "校验中…" : "保存并校验")), h("div", { className: "dsv-muted" }, "备用方式:在浏览器登录 ", h("a", {
				className: "dsv-link",
				href: "https://chat.deepseek.com/sign_in",
				target: "_blank",
				rel: "noreferrer"
			}, "chat.deepseek.com"), " 后,控制台运行 ", h("span", { className: "dsv-code" }, "copy(JSON.parse(localStorage.userToken).value)"), " 复制 token 粘贴到上面。"));
			return h("div", { className: "dsv-page" }, h("div", { className: "dsv-card" }, h("div", { className: "dsv-title" }, "DeepSeek 官网视觉(识图)桥"), h("div", null, statusLine), status.loggedIn ? h("div", { className: "dsv-row" }, h("button", {
				className: "dsv-btn",
				onClick: doTest,
				disabled: busy
			}, "识图测试"), h("button", {
				className: "dsv-btn",
				onClick: doLogout,
				disabled: busy
			}, "退出登录")) : null, msg ? h("div", { className: msg.ok ? "dsv-ok" : "dsv-err" }, msg.text) : null), !status.loggedIn && !status.loading ? h("div", { className: "dsv-card" }, tabs, mode === "wechat" ? wechatPane : mode === "password" ? passwordPane : tokenPane) : null, h("div", { className: "dsv-card" }, h("div", { className: "dsv-title" }, "说明"), h("div", { className: "dsv-muted" }, "微信扫码走官网同款链路:微信开放平台二维码 → 官网服务端换码 → oauth/get_token 取 userToken。识图调用链:上传图片 → fork 到视觉模型 → 新建会话 → 流式 completion → 用后即删会话,请求携带官网 PoW(官方 wasm 求解)。开启后可在会话输入框直接粘贴/拖入图片发送,插件会在消息进入模型前自动完成识图并转为文字描述。原图由 DSH 附件库统一存储管理,识图结果中附原图路径供 deepseek_vision 追问。登录态通过官方 credentials 服务保存于 ~/.dsh/.credentials.yaml(权限 600、不进环境变量),插件重启/升级/DSH 重启均自动恢复;在设置页退出登录即清除。")));
		}
		/** Client plugin body. */
		function apply(ctx) {
			ensureStyles();
			let disposeReg = null;
			const off = ctx.slots.inject("settings.section", () => {
				disposeReg = ctx.slots.register({
					name: "settings.section",
					id: "dsvision",
					label: "DeepSeek 视觉",
					order: 90
				}, () => (0, react.createElement)(DsvSettings));
			});
			ctx.effect(() => () => {
				try {
					off();
				} catch {}
				try {
					if (disposeReg) disposeReg();
				} catch {}
				if (styleEl) {
					try {
						styleEl.remove();
					} catch {}
					styleEl = null;
				}
			}, "dsh-deepseek-vision-bridge: client cleanup");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client-registry.js.map