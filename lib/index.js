import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "@deepseek-ai/cordis";
//#region node_modules/@deepseek-ai/dsh-credentials/lib/index.js
/**
* Service Definition for the credential-reference capability seam (`ctx.credentials`). Settings and composition files carry
* *references* to secrets — environment-variable names — while providers own
* the actual values and their storage. Consumers resolve a reference once per
* operation, so a changed credential reaches the next operation without any
* plugin restart, and configuration surfaces describe a reference without
* ever seeing its value.
* @module @deepseek-ai/dsh-credentials
*/
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
* Brand a raw string as a {@link CredentialRef}.
* @param value - candidate reference; a POSIX shell identifier such as `DEEPSEEK_API_KEY`.
* @returns the branded reference.
*/
function credentialRef(value) {
	if (!REF_PATTERN.test(value)) throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`);
	return value;
}
//#endregion
//#region src/index.ts
/**
* dsh-deepseek-vision-bridge — host half.
*
* Bridges chat.deepseek.com's (reverse-engineered, unofficial) vision mode
* into DSH so text-only models can still "see" images:
*
*   1. `deepseek_vision` model tool — analyze an image path/URL and return a
*      structured textual description (scene, verbatim text transcription,
*      key data, inference).
*   2. In-chat images — a capability patch on `llm.resolveModelInfo` admits
*      image input for text-only models, then the official `agent/pre-step`
*      waterfall replaces each image block with its vision transcription
*      before the step enters the model. The durable log keeps the image;
*      only the model-facing copy is swapped. `llm/stream` is a last-resort
*      net that placeholders any image block that still reaches a
*      genuinely text-only model.
*   3. Settings page (client half) — WeChat QR / password / userToken login.
*      The token persists through the official credentials service
*      (~/.dsh/.credentials.yaml, ref DSV_USER_TOKEN).
*
* All DeepSeek protocol work (PoW wasm, upload/fork/completion SSE, WeChat
* long-poll) lives in `worker.mjs`, spawned per operation as plain Node.
*/
/** Plugin identity for cordis.yml rows. */
const name = "dsh-deepseek-vision-bridge";
/** Services required before mounting. */
const inject = [
	"webServer",
	"tools",
	"llm",
	"attachments",
	"credentials"
];
const TOKEN_REF = credentialRef("DSV_USER_TOKEN");
const API_PREFIX = "/dsv/api";
/** Run one worker op; resolves to the worker's parsed JSON result. */
function runWorker(args, stdin, timeoutMs = 3e5) {
	return new Promise((resolve, reject) => {
		const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.mjs");
		const argv = Buffer.from(JSON.stringify(args)).toString("base64");
		const child = spawn(process.execPath, [workerPath, argv], {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: { ...process.env }
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c) => {
			stdout += c;
		});
		child.stderr.on("data", (c) => {
			stderr += c;
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`worker spawn failed: ${e.message}`));
		});
		child.on("close", () => {
			clearTimeout(timer);
			const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
			const line = lines.length ? lines[lines.length - 1] : "";
			if (line) try {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed.ok === "boolean") return resolve(parsed);
			} catch {}
			reject(/* @__PURE__ */ new Error(`worker failed (exit=${child.exitCode}): ${stderr.slice(0, 300)}`));
		});
		if (stdin !== void 0) child.stdin.end(stdin);
		else child.stdin.end();
	});
}
/** Conservative browser-trust fence: loopback Host headers only. */
function isTrustedRequest(req) {
	const hostname = String(req.headers.host || "").split(":")[0].toLowerCase();
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
function readJsonBody(req, limit = 8388608) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) {
				reject(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
			} catch (e) {
				reject(/* @__PURE__ */ new Error("bad json body"));
			}
		});
		req.on("error", reject);
	});
}
function apply(ctx) {
	const state = {
		token: null,
		account: null
	};
	const credentials = ctx.credentials;
	const persistToken = async (t) => {
		if (!credentials) return;
		try {
			if (t) await credentials.set(TOKEN_REF, t);
			else await credentials.unset(TOKEN_REF);
		} catch (e) {
			console.error("[dsv] credential set failed:", e);
		}
	};
	(async () => {
		if (!credentials) {
			console.error("[dsv] credentials service unavailable — login will not persist");
			return;
		}
		try {
			const hit = await credentials.resolve(TOKEN_REF);
			if (hit && hit.value) {
				const r = await runWorker({
					op: "check",
					token: hit.value
				}, void 0, 6e4);
				if (r.ok && r.loggedIn) {
					state.token = hit.value;
					state.account = r.account ?? null;
					console.log("[dsv] token restored from credentials service");
				} else await credentials.unset(TOKEN_REF);
			}
		} catch (e) {
			console.error("[dsv] token restore failed:", e);
		}
	})();
	async function doLogin(a) {
		if (!a.password || !a.email && !a.mobile) return {
			ok: false,
			error: "请填写账号(邮箱或手机号)和密码"
		};
		const r = await runWorker({
			op: "login",
			email: a.email,
			mobile: a.mobile,
			areaCode: a.areaCode,
			password: a.password
		}, void 0, 6e4);
		if (r.ok && r.token) {
			state.token = r.token;
			state.account = r.account ?? null;
			persistToken(r.token);
		}
		return r;
	}
	async function doTokenLogin(a) {
		const t = String(a.token || "").trim();
		if (!t) return {
			ok: false,
			error: "token 为空"
		};
		const r = await runWorker({
			op: "check",
			token: t
		}, void 0, 6e4);
		if (r.ok && r.loggedIn) {
			state.token = t;
			state.account = r.account ?? null;
			persistToken(t);
			return {
				ok: true,
				account: r.account
			};
		}
		return {
			ok: false,
			error: r.error || "token 无效"
		};
	}
	async function doWxLogin(a) {
		const r = await runWorker({
			op: "wxlogin",
			code: a.code
		}, void 0, 6e4);
		if (r.ok && r.token) {
			state.token = r.token;
			state.account = r.account ?? null;
			persistToken(r.token);
		}
		return r;
	}
	async function doLogout() {
		state.token = null;
		state.account = null;
		await persistToken(null);
		return { ok: true };
	}
	/** Core analyze used by both the HTTP route (settings test button) and the tool. */
	async function analyze(a) {
		if (state.token === null) return {
			ok: false,
			error: "NOT_LOGGED_IN"
		};
		const images = [];
		for (const im of Array.isArray(a.images) ? a.images : []) {
			if (!im) continue;
			if (typeof im.path === "string" && im.path) images.push({ path: im.path });
			else if (typeof im.url === "string" && im.url) images.push({ url: im.url });
			else if (typeof im.base64 === "string" && im.base64) images.push({
				base64: im.base64,
				mime: im.mime,
				name: im.name
			});
		}
		if (!images.length) return {
			ok: false,
			error: "NO_IMAGES"
		};
		const r = await runWorker({
			op: "analyze",
			token: state.token,
			images,
			prompt: a.prompt
		});
		if (r.ok !== true && /Authorization Failed|invalid token|not logged in/i.test(String(r.error || ""))) {
			state.token = null;
			state.account = null;
			persistToken(null);
			return {
				ok: false,
				error: "NOT_LOGGED_IN"
			};
		}
		return r;
	}
	const disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			const finish = (code, body) => {
				res.writeHead(code, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(JSON.stringify(body));
			};
			if (!isTrustedRequest(req)) return finish(403, {
				ok: false,
				error: "forbidden host"
			});
			if (req.method !== "POST") return finish(405, {
				ok: false,
				error: "method not allowed"
			});
			try {
				const body = await readJsonBody(req);
				switch (String(body.op || req.url?.slice(9) || "")) {
					case "status": return finish(200, {
						ok: true,
						loggedIn: state.token !== null,
						account: state.account
					});
					case "login": return finish(200, await doLogin(body));
					case "token": return finish(200, await doTokenLogin(body));
					case "logout": return finish(200, await doLogout());
					case "wxqr": return finish(200, await runWorker({ op: "wxqr" }, void 0, 6e4));
					case "wxpoll": return finish(200, await runWorker({
						op: "wxpoll",
						uuid: body.uuid,
						last: body.last
					}, void 0, 6e4));
					case "wxlogin": return finish(200, await doWxLogin(body));
					case "analyze": return finish(200, await analyze(body));
					default: return finish(404, {
						ok: false,
						error: "unknown op"
					});
				}
			} catch (e) {
				return finish(500, {
					ok: false,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
	});
	let unpatchLlm = null;
	let origResolveModelInfo = null;
	const llm = ctx.llm;
	if (llm && typeof llm.resolveModelInfo === "function") try {
		origResolveModelInfo = llm.resolveModelInfo.bind(llm);
		llm.resolveModelInfo = async function patchedResolveModelInfo(provider, model, signal) {
			const info = await origResolveModelInfo(provider, model, signal);
			if (info && Array.isArray(info.inputModalities) && !info.inputModalities.includes("image")) {
				const copy = Object.assign({}, info, { inputModalities: info.inputModalities.slice() });
				copy.inputModalities.push("image");
				return copy;
			}
			return info;
		};
		unpatchLlm = () => {
			try {
				if (origResolveModelInfo) llm.resolveModelInfo = origResolveModelInfo;
			} catch {}
		};
		console.log("[dsv] capability patch installed (text-only models now admit image input)");
	} catch (e) {
		console.error("[dsv] capability patch failed:", e);
		unpatchLlm = null;
	}
	else console.error("[dsv] llm.resolveModelInfo unavailable — in-chat images disabled, the tool still works");
	function b64FromBytes(bytes) {
		let s = "";
		const CHUNK = 32768;
		for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
		return btoa(s);
	}
	async function describeImageBlocks(blocks) {
		if (state.token === null) throw new Error("NOT_LOGGED_IN(请在 设置 → DeepSeek 视觉 登录)");
		const list = [];
		for (const b of blocks) {
			const block = b;
			const ref = block && block.attachment;
			if (!ref) continue;
			const stored = await ctx.attachments.readImage(ref);
			const data = stored && stored.data;
			if (!data) continue;
			const ext = String(ref.mediaType || "image/png").split("/")[1] || "png";
			list.push({
				name: `image_${list.length}.${ext}`,
				mime: ref.mediaType || "image/png",
				b64: b64FromBytes(data)
			});
		}
		if (!list.length) throw new Error("无法读取图片附件");
		const prompt = list.length > 1 ? `共 ${list.length} 张图片。请逐张全面分析,每张分别给出:1)整体描述(场景/主体/布局) 2)图中所有文字的逐字转写 3)关键信息(数据/UI 状态/异常报错) 4)推断与上下文;最后说明图片之间的关系(如有)。用中文分条作答。` : void 0;
		const r = await runWorker({
			op: "analyze",
			token: state.token,
			imagesStdin: true,
			prompt
		}, JSON.stringify(list));
		if (!r || !r.ok) throw new Error(r && r.error || "识图失败");
		const paths = Array.isArray(r.paths) ? r.paths.filter(Boolean) : [];
		const refNote = paths.length ? `;原图: ${paths.join(" , ")}(DSH 附件库,可用 deepseek_vision 追问)` : ";原图在 DSH 附件库中";
		return `[DeepSeek 视觉识图结果${list.length > 1 ? `(${list.length} 张)` : ""}${refNote}]\n${r.text ?? ""}`;
	}
	function copyMessageWithContent(m, content) {
		try {
			const copy = Object.assign(Object.create(Object.getPrototypeOf(m)), m);
			copy.content = content;
			return copy;
		} catch {
			return Object.assign({}, m, { content });
		}
	}
	const offPreStep = ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		if (!decision || decision.kind !== "enter" || !Array.isArray(decision.messages)) return decision;
		let changed = false;
		const out = [];
		for (const m of decision.messages) {
			const content = m.content;
			if (!Array.isArray(content)) {
				out.push(m);
				continue;
			}
			const blocks = content;
			const imgs = blocks.filter((b) => b?.type === "image");
			if (!imgs.length) {
				out.push(m);
				continue;
			}
			let text;
			try {
				text = await describeImageBlocks(imgs);
			} catch (e) {
				text = `[DeepSeek 视觉未能处理本条消息中的图片:${e instanceof Error ? e.message : String(e)};原图仍保留在会话记录中,登录后可让我用 deepseek_vision 工具补看]`;
			}
			changed = true;
			const newContent = blocks.filter((b) => b?.type !== "image");
			newContent.push({
				type: "text",
				text
			});
			out.push(copyMessageWithContent(m, newContent));
		}
		if (!changed) return decision;
		return {
			kind: "enter",
			messages: out
		};
	});
	const modalityCache = {};
	async function modelIsTextOnly(provider, model) {
		const key = `${provider}/${model}`;
		if (key in modalityCache) return modalityCache[key];
		let verdict = false;
		try {
			if (origResolveModelInfo) {
				const info = await origResolveModelInfo(provider, model);
				verdict = !!(info && Array.isArray(info.inputModalities) && !info.inputModalities.includes("image"));
			}
		} catch {
			verdict = false;
		}
		modalityCache[key] = verdict;
		return verdict;
	}
	const offStream = ctx.on("llm/stream", async function* (options, next) {
		try {
			const msgs = options.messages;
			if (Array.isArray(msgs) && msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "image")) && origResolveModelInfo) {
				if (await modelIsTextOnly(options.provider || "", options.model || "")) {
					for (const m of msgs) if (Array.isArray(m.content) && m.content.some((b) => b?.type === "image")) m.content = m.content.map((b) => b?.type === "image" ? {
						type: "text",
						text: "[此处原为一张图片,已由 DeepSeek 视觉转为文字描述,见对应消息]"
					} : b);
				}
			}
		} catch {}
		yield* next();
	});
	const disposeTool = ctx.tools.register({
		name: "deepseek_vision",
		description: "用 DeepSeek 官网识图模式分析图片,返回文字描述。当前运行模型没有视觉能力:凡用户给出图片(路径/URL)或要求看图、识图、读截图、提取图中文字时,调用本工具,不要凭空猜测图片内容。硬性要求:prompt 必须附带一句针对该图的完整提问,覆盖——整体内容、图中所有文字的逐字转写、值得关注的关键信息(数据/UI 状态/异常报错),并结合用户当前意图;禁止留空或泛泛一句。images: [{path}|{url}](1-5 张)。需要用户先在 设置 → DeepSeek 视觉 登录;未登录时返回 NOT_LOGGED_IN,应提示用户去设置登录。调用产生的临时会话用后自动删除。",
		parameters: {
			images: {
				type: "array",
				required: true,
				description: "待分析的图片列表,每项 path(本地文件路径)或 url(网络图片)二选一",
				item: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "本地图片文件绝对路径"
						},
						url: {
							type: "string",
							description: "图片 URL"
						}
					}
				}
			},
			prompt: {
				type: "string",
				required: true,
				description: "针对图片的完整问题,须涵盖:整体内容、全部文字转写、关键信息(数据/UI 状态/报错),并贴合用户意图"
			}
		},
		output: {
			schema: { type: "string" },
			render(_args, value) {
				return [{
					type: "text",
					text: String(value)
				}];
			}
		},
		async execute(args) {
			const r = await analyze(args);
			if (r.ok) {
				const clean = r.deleted === false ? ";警告:临时会话删除失败,用户可去 DeepSeek 网页检查会话列表" : ";临时会话已自动删除";
				return `识图完成(${r.images} 张图,耗时 ${Math.round((r.ms || 0) / 1e3)}s${clean})。模型回答:\n\n${r.text}`;
			}
			if (r.error === "NOT_LOGGED_IN") return `识图失败:NOT_LOGGED_IN\n提示:请在 设置 → DeepSeek 视觉 登录(微信扫码/密码/userToken)后重试`;
			return `识图失败:${r.error || "unknown"}`;
		}
	});
	ctx.effect(() => () => {
		try {
			disposeRoute();
		} catch {}
		try {
			offPreStep();
		} catch {}
		try {
			offStream();
		} catch {}
		try {
			disposeTool();
		} catch {}
		if (unpatchLlm) try {
			unpatchLlm();
		} catch {}
	}, "dsh-deepseek-vision-bridge: cleanup");
	console.log("[dsv] host ready; in-chat images " + (llm ? "enabled" : "disabled") + ", token persists via credentials service (DSV_USER_TOKEN)");
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map