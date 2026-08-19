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
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: pull the `declare module '@deepseek-ai/cordis'` augmentations
// (Context.llm / Context.tools / the agent+llm events) into
// this compilation without any runtime dependency.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-deepseek-vision-bridge'

/** Services required before mounting. */
export const inject = ['webServer', 'tools', 'llm', 'credentials']

const TOKEN_REF = credentialRef('DSV_USER_TOKEN')
const API_PREFIX = '/dsv/api'

type Json = Record<string, unknown>

interface WorkerResult {
  [key: string]: unknown
  ok: boolean
  error?: string
  bizCode?: number
  // op-specific fields
  loggedIn?: boolean
  token?: string
  account?: { email: string | null; mobile: string | null } | null
  uuid?: string
  errcode?: number
  code?: string
  text?: string
  images?: number
  paths?: string[]
  deleted?: boolean
  ms?: number
}

/** Run one worker op; resolves to the worker's parsed JSON result. */
function runWorker(args: Json, stdin?: string, timeoutMs = 300_000): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs')
    const argv = Buffer.from(JSON.stringify(args)).toString('base64')
    const child = spawn(process.execPath, [workerPath, argv], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', e => { clearTimeout(timer); reject(new Error(`worker spawn failed: ${e.message}`)) })
    child.on('close', () => {
      clearTimeout(timer)
      const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'))
      const line = lines.length ? lines[lines.length - 1] : ''
      if (line) {
        try {
          const parsed = JSON.parse(line) as WorkerResult
          if (parsed && typeof parsed.ok === 'boolean') return resolve(parsed)
        } catch { /* fall through */ }
      }
      reject(new Error(`worker failed (exit=${child.exitCode}): ${stderr.slice(0, 300)}`))
    })
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

// ---- HTTP surface for the client half (settings page) ----

/** Conservative browser-trust fence: loopback Host headers only. */
function isTrustedRequest(req: IncomingMessage): boolean {
  const host = String(req.headers.host || '')
  const hostname = host.split(':')[0].toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

function readJsonBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch (e) { reject(new Error('bad json body')) }
    })
    req.on('error', reject)
  })
}

export function apply(ctx: Context): void {
  const state: { token: string | null; account: { email: string | null; mobile: string | null } | null } = {
    token: null,
    account: null,
  }

  const credentials = ctx.credentials

  // Quiet-startup logging (v0.2.2): everything routes through the cordis
  // logger so output respects log levels, routine success is debug-quiet,
  // and failures stay loud at warn/error. A single info line summarizes
  // readiness at the end of apply.
  const logger = ctx.logger
  const logInfo = (msg: string): void => { logger?.info?.(`[dsv] ${msg}`) }
  const logDebug = (msg: string): void => { logger?.debug?.(`[dsv] ${msg}`) }
  const logWarn = (msg: string): void => { logger?.warn?.(`[dsv] ${msg}`) }
  const logError = (msg: string, e?: unknown): void => {
    if (e === undefined) logger?.error?.(`[dsv] ${msg}`)
    else logger?.error?.(`[dsv] ${msg}`, e)
  }

  const persistToken = async (t: string | null): Promise<void> => {
    if (!credentials) return
    try {
      if (t) await credentials.set(TOKEN_REF, t)
      else await credentials.unset(TOKEN_REF)
    } catch (e) {
      logError('credential set failed', e)
    }
  }

  // Startup: restore the token from the credentials service and verify it.
  void (async () => {
    if (!credentials) { logWarn('credentials service unavailable — login will not persist'); return }
    try {
      const hit = await credentials.resolve(TOKEN_REF)
      if (hit && hit.value) {
        const r = await runWorker({ op: 'check', token: hit.value }, undefined, 60_000)
        if (r.ok && r.loggedIn) {
          state.token = hit.value
          state.account = r.account ?? null
          logDebug('token restored from credentials service')
        } else {
          await credentials.unset(TOKEN_REF)
        }
      }
    } catch (e) {
      logError('token restore failed', e)
    }
  })()

  // ---- login/logout operations shared by HTTP routes ----
  async function doLogin(a: Json): Promise<WorkerResult> {
    if (!a.password || (!a.email && !a.mobile)) return { ok: false, error: '请填写账号(邮箱或手机号)和密码' }
    const r = await runWorker({ op: 'login', email: a.email, mobile: a.mobile, areaCode: a.areaCode, password: a.password }, undefined, 60_000)
    if (r.ok && r.token) {
      state.token = r.token
      state.account = r.account ?? null
      void persistToken(r.token)
    }
    return r
  }

  async function doTokenLogin(a: Json): Promise<WorkerResult> {
    const t = String(a.token || '').trim()
    if (!t) return { ok: false, error: 'token 为空' }
    const r = await runWorker({ op: 'check', token: t }, undefined, 60_000)
    if (r.ok && r.loggedIn) {
      state.token = t
      state.account = r.account ?? null
      void persistToken(t)
      return { ok: true, account: r.account }
    }
    return { ok: false, error: r.error || 'token 无效' }
  }

  async function doWxLogin(a: Json): Promise<WorkerResult> {
    const r = await runWorker({ op: 'wxlogin', code: a.code }, undefined, 60_000)
    if (r.ok && r.token) {
      state.token = r.token
      state.account = r.account ?? null
      void persistToken(r.token)
    }
    return r
  }

  async function doLogout(): Promise<WorkerResult> {
    state.token = null
    state.account = null
    await persistToken(null)
    return { ok: true }
  }

  /** Core analyze used by both the HTTP route (settings test button) and the tool. */
  async function analyze(a: Json): Promise<WorkerResult> {
    if (state.token === null) {
      return { ok: false, error: 'NOT_LOGGED_IN' }
    }
    const images: Json[] = []
    for (const im of (Array.isArray(a.images) ? a.images : []) as Json[]) {
      if (!im) continue
      if (typeof im.path === 'string' && im.path) images.push({ path: im.path })
      else if (typeof im.url === 'string' && im.url) images.push({ url: im.url })
      else if (typeof im.base64 === 'string' && im.base64) images.push({ base64: im.base64, mime: im.mime, name: im.name })
    }
    if (!images.length) return { ok: false, error: 'NO_IMAGES' }
    const r = await runWorker({ op: 'analyze', token: state.token, images, prompt: a.prompt })
    if (r.ok !== true && /Authorization Failed|invalid token|not logged in/i.test(String(r.error || ''))) {
      state.token = null
      state.account = null
      void persistToken(null)
      return { ok: false, error: 'NOT_LOGGED_IN' }
    }
    return r
  }

  // ---- HTTP routes ----
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const finish = (code: number, body: Json): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      if (!isTrustedRequest(req)) return finish(403, { ok: false, error: 'forbidden host' })
      if (req.method !== 'POST') return finish(405, { ok: false, error: 'method not allowed' })
      try {
        const body = await readJsonBody(req)
        const op = String(body.op || req.url?.slice(API_PREFIX.length + 1) || '')
        switch (op) {
          case 'status':
            return finish(200, { ok: true, loggedIn: state.token !== null, account: state.account })
          case 'login': return finish(200, await doLogin(body))
          case 'token': return finish(200, await doTokenLogin(body))
          case 'logout': return finish(200, await doLogout())
          case 'wxqr': {
            const r = await runWorker({ op: 'wxqr' }, undefined, 60_000)
            return finish(200, r)
          }
          case 'wxpoll': {
            const r = await runWorker({ op: 'wxpoll', uuid: body.uuid, last: body.last }, undefined, 60_000)
            return finish(200, r)
          }
          case 'wxlogin': return finish(200, await doWxLogin(body))
          case 'analyze': return finish(200, await analyze(body))
          default:
            return finish(404, { ok: false, error: 'unknown op' })
        }
      } catch (e) {
        return finish(500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

  // ① Capability patch: text-only models additionally admit image input, so
  // the api-proxy's image gate lets in-chat images through. Reverted on stop.
  let unpatchLlm: (() => void) | null = null
  let origResolveModelInfo: ((provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[] } & Record<string, unknown>>) | null = null
  type LlmService = { resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[] } & Record<string, unknown>> }
  const llm = ctx.llm as unknown as LlmService | undefined
  if (llm && typeof llm.resolveModelInfo === 'function') {
    try {
      origResolveModelInfo = llm.resolveModelInfo.bind(llm)
      llm.resolveModelInfo = async function patchedResolveModelInfo(provider, model, signal) {
        const info = await origResolveModelInfo!(provider, model, signal)
        if (info && Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
          const copy = Object.assign({}, info, { inputModalities: info.inputModalities.slice() })
          copy.inputModalities.push('image')
          return copy
        }
        return info
      }
      unpatchLlm = () => {
        try { if (origResolveModelInfo) llm.resolveModelInfo = origResolveModelInfo } catch { /* leave the patch; it reverts on process restart */ }
      }
      // No success line here: the host-ready summary at the end of apply()
      // reports whether in-chat images are enabled or disabled.
    } catch (e) {
      logError('capability patch failed', e)
      unpatchLlm = null
    }
  } else {
    logWarn('llm.resolveModelInfo unavailable — in-chat images disabled, the tool still works')
  }

  // ② In-chat images → lazy placeholder cards. The pre-step waterfall swaps
  // each image block for a text card carrying the ORIGINAL image's stable
  // content-addressed path; the swapped copy lands on the model-only surface
  // (the UI transcript keeps showing the original image). The MODEL then
  // decides — per user intent, per turn — whether/what to ask through the
  // deepseek_vision tool, instead of being force-fed one eager transcription
  // with a generic prompt.
  function attachmentObjectPath(ref: ImageAttachmentRef): string | null {
    // attachmentId is "sha256:<64hex>"; objects live under objects/<2>/<64>
    const id = String(ref.attachmentId || '')
    const m = /^sha256:([a-f0-9]{64})$/.exec(id)
    if (!m) return null
    const hex = m[1]
    const home = process.env.DSH_HOME
      ?? (process.env.HOME ? `${process.env.HOME}/.dsh` : null)
    if (!home) return null
    return `${home}/attachments/v1/objects/${hex.slice(0, 2)}/${hex}`
  }

  function imageCardText(ref: ImageAttachmentRef, index: number, total: number): string {
    const path = attachmentObjectPath(ref)
    const parts = [
      `[图片 ${index}/${total}`,
      String(ref.mediaType || 'image/png').split('/')[1] || 'png',
      ref.width && ref.height ? `${ref.width}×${ref.height}` : null,
      ref.bytes ? `${Math.round(ref.bytes / 1024)}KB` : null,
      '本会话模型无视觉能力',
    ].filter(Boolean)
    const head = parts.join(' · ') + ']'
    const body = path
      ? `原图路径: ${path}`
      : '原图在 DSH 附件库(content-addressed,attachmentId 见本条消息元数据)'
    const guide = '请用 deepseek_vision 工具分析此图:prompt 由你结合用户当前意图撰写(整体内容/全部文字转写/关键信息/用户真正想问的点),不要套用固定模板;无需分析时可忽略。'
    return `${head}\n${body}\n${guide}`
  }

  function copyMessageWithContent<T extends { content: unknown }>(m: T, content: unknown[]): T {
    try {
      const copy = Object.assign(Object.create(Object.getPrototypeOf(m)), m) as T & { content: unknown }
      copy.content = content
      return copy
    } catch {
      return Object.assign({}, m, { content }) as T
    }
  }

  const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    let changed = false
    const out: typeof decision.messages = []
    for (const m of decision.messages) {
      const content: unknown = m.content
      if (!Array.isArray(content)) { out.push(m); continue }
      const blocks = content as unknown[]
      const imgRefs: ImageAttachmentRef[] = []
      for (const b of blocks) {
        const ref = (b as { attachment?: ImageAttachmentRef } | null)?.attachment
        if (ref) imgRefs.push(ref)
      }
      if (!imgRefs.length) { out.push(m); continue }
      changed = true
      const total = imgRefs.length
      let i = 0
      const newContent = blocks.map(b => {
        const ref = (b as { attachment?: ImageAttachmentRef } | null)?.attachment
        if (!ref) return b
        i += 1
        return { type: 'text', text: imageCardText(ref, i, total) }
      })
      out.push(copyMessageWithContent(m, newContent))
    }
    if (!changed) return decision
    return { kind: 'enter', messages: out }
  })

  // ③ llm/stream net: swap any image block that still reaches a genuinely
  // text-only model (checked through the UNPATCHED resolver) for the same
  // path-carrying card, so even pre-plugin history keeps the tool handle.
  const modalityCache: Record<string, boolean> = {}
  async function modelIsTextOnly(provider: string, model: string): Promise<boolean> {
    const key = `${provider}/${model}`
    if (key in modalityCache) return modalityCache[key]
    let verdict = false
    try {
      if (origResolveModelInfo) {
        const info = await origResolveModelInfo(provider, model)
        verdict = !!(info && Array.isArray(info.inputModalities) && !info.inputModalities.includes('image'))
      }
    } catch { verdict = false }
    modalityCache[key] = verdict
    return verdict
  }

  const offStream = ctx.on('llm/stream', async function* (options, next) {
    try {
      const msgs = (options as { messages?: { content?: unknown[] }[]; provider?: string; model?: string }).messages
      const hasImage = Array.isArray(msgs) && msgs.some(m => Array.isArray(m.content) && m.content.some(b => (b as { type?: string } | null)?.type === 'image'))
      if (hasImage && origResolveModelInfo) {
        const provider = (options as { provider?: string }).provider || ''
        const model = (options as { model?: string }).model || ''
        if (await modelIsTextOnly(provider, model)) {
          for (const m of msgs!) {
            if (Array.isArray(m.content) && m.content.some(b => (b as { type?: string } | null)?.type === 'image')) {
              const refs = m.content
                .map(b => (b as { attachment?: ImageAttachmentRef } | null)?.attachment)
                .filter(Boolean) as ImageAttachmentRef[]
              const total = refs.length
              let i = 0
              m.content = m.content.map(b => {
                const ref = (b as { attachment?: ImageAttachmentRef } | null)?.attachment
                if (!ref) return b
                i += 1
                return { type: 'text', text: imageCardText(ref, i, total) }
              })
            }
          }
        }
      }
    } catch { /* the net must never break the call */ }
    yield* next()
  })

  // ---- model tool ----
  const disposeTool = ctx.tools.register({
    name: 'deepseek_vision',
    description: '用 DeepSeek 官网识图模式分析图片,返回文字描述——本会话模型没有视觉能力,这是你「看图」的唯一途径。用户消息里的图片会以占位卡出现(含原图稳定路径):拿到占位卡、用户提到图、或你需要看某张图时,调用本工具。prompt 由你结合用户当前意图撰写,覆盖与意图相关的方面(通常包括:整体内容、图中文字逐字转写、关键数据/UI 状态/报错、用户真正想问的点),不要套用固定模板、不要泛泛一句;多张图可一次调用(说明分别分析)或按需分次。images: [{path}|{url}](1-5 张),占位卡里的路径可直接作为 path 使用。需要用户先在 设置 → DeepSeek 视觉 登录;未登录返回 NOT_LOGGED_IN,应提示用户去设置登录。临时会话用后自动删除。',
    parameters: {
      images: {
        type: 'array',
        required: true,
        description: '待分析的图片列表,每项 path(本地文件路径)或 url(网络图片)二选一',
        item: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '本地图片文件绝对路径' },
            url: { type: 'string', description: '图片 URL' },
          },
        },
      },
      prompt: {
        type: 'string',
        required: true,
        description: '针对图片的完整问题,须涵盖:整体内容、全部文字转写、关键信息(数据/UI 状态/报错),并贴合用户意图',
      },
    } as never,
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    async execute(args) {
      const a = args as { images?: unknown[]; prompt?: string }
      const r = await analyze(a as Json)
      if (r.ok) {
        const clean = r.deleted === false ? ';警告:临时会话删除失败,用户可去 DeepSeek 网页检查会话列表' : ';临时会话已自动删除'
        return `识图完成(${r.images} 张图,耗时 ${Math.round((r.ms || 0) / 1000)}s${clean})。模型回答:\n\n${r.text}`
      }
      if (r.error === 'NOT_LOGGED_IN') {
        return `识图失败:NOT_LOGGED_IN\n提示:请在 设置 → DeepSeek 视觉 登录(微信扫码/密码/userToken)后重试`
      }
      return `识图失败:${r.error || 'unknown'}`
    },
  })

  ctx.effect(() => () => {
    try { disposeRoute() } catch { }
    try { offPreStep() } catch { }
    try { offStream() } catch { }
    try { disposeTool() } catch { }
    if (unpatchLlm) { try { unpatchLlm() } catch { } }
    // Credential hygiene on uninstall: hot reload / update / stop keep the
    // token (the package directory survives, so re-login is unnecessary);
    // a real uninstall deletes the package directory — its package.json is
    // gone by disposal time, which is the signal to drop the stored token.
    try {
      const packageJson = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
      if (!existsSync(packageJson)) {
        logInfo('package directory gone (uninstall) — dropping stored token')
        void credentials?.unset(TOKEN_REF).catch(() => { })
      }
    } catch { /* never block disposal */ }
  }, 'dsh-deepseek-vision-bridge: cleanup')

  logInfo('host ready; in-chat images ' + (llm ? 'enabled' : 'disabled') + ', token persists via credentials service (DSV_USER_TOKEN)')
}
