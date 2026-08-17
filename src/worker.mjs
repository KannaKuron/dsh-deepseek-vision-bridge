// dsh-deepseek-vision-bridge worker — runs under plain Node (>=18). One JSON line on stdout per op.
// usage: node worker.mjs '<base64 argv json>'  (stdin carries images for op=analyze&imagesStdin)
// ops: check | login | analyze | wxqr | wxpoll | wxlogin
//
// Protocol notes (reverse-engineered from chat.deepseek.com, verified live):
// - PoW: POST /api/v0/chat/create_pow_challenge {target_path} → solve with the
//   official DeepSeekHashV1 wasm (sha3_wasm_bg.wasm, zero imports) →
//   x-ds-pow-response: base64({algorithm,challenge,salt,answer,signature,target_path})
// - Vision: upload_file (multipart + PoW) → fork_file_task {to_model_type:"vision"} →
//   chat_session/create → chat/completion {model_type:"vision", ref_file_ids} (SSE) →
//   chat_session/delete (always, in finally)
// - WeChat QR login: open.weixin.qq.com/connect/qrConnect (appid wx932d4fdaf46d5611) →
//   long-poll long.open.weixin.qq.com/connect/l/qrconnect → code →
//   /api/v0/users/oauth/wechat/callback (307 with nonce) → /api/v0/users/oauth/get_token
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const BASE = 'https://chat.deepseek.com'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const WX_APPID = 'wx932d4fdaf46d5611'
const WX_REDIRECT = encodeURIComponent(BASE + '/api/v0/users/oauth/wechat/callback')
const ATT_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'attachments', 'v1')

const H = {
  'user-agent': UA,
  'accept': '*/*',
  'accept-language': 'zh-CN,zh;q=0.9',
  'origin': BASE,
  'referer': BASE + '/',
  'x-app-version': '2.3.0',
  'x-client-version': '2.3.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', c => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)))
    process.stdin.on('error', reject)
  })
}

// ---- PoW solver (official wasm, loaded from the file next to this script) ----
let wasmInst = null
function getWasm() {
  if (wasmInst) return wasmInst
  const bin = fs.readFileSync(new URL('./sha3.wasm', import.meta.url))
  wasmInst = new WebAssembly.Instance(new WebAssembly.Module(bin), {})
  return wasmInst
}
function powHeader(ch) {
  const exp = getWasm().exports
  const enc = new TextEncoder()
  const write = s => {
    const b = enc.encode(s)
    const ptr = exp.__wbindgen_export_0(b.length, 1)
    new Uint8Array(exp.memory.buffer).set(b, ptr)
    return { ptr, len: b.length }
  }
  const prefix = ch.salt + '_' + ch.expire_at + '_'
  const retptr = exp.__wbindgen_add_to_stack_pointer(-16)
  let answer
  try {
    const c = write(ch.challenge), p = write(prefix)
    exp.wasm_solve(retptr, c.ptr, c.len, p.ptr, p.len, ch.difficulty)
    if (new Int32Array(exp.memory.buffer)[retptr / 4] === 0) throw new Error('pow: no solution (expired?)')
    answer = Math.floor(new Float64Array(exp.memory.buffer)[(retptr + 8) / 8])
  } finally { exp.__wbindgen_add_to_stack_pointer(16) }
  const payload = { algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt, answer, signature: ch.signature, target_path: ch.target_path }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

async function api(pathname, { method = 'GET', body, token, powFor, form, timeoutMs = 120000 } = {}) {
  const headers = { ...H }
  if (token) headers.authorization = 'Bearer ' + token
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (powFor) {
    const chResp = await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ target_path: powFor }),
    })
    const chJson = await chResp.json()
    const ch = chJson?.data?.biz_data?.challenge
    if (!ch) throw new Error('PoW challenge failed: HTTP ' + chResp.status + ' ' + JSON.stringify(chJson).slice(0, 200))
    headers['x-ds-pow-response'] = powHeader(ch)
  }
  const resp = await fetch(BASE + pathname, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await resp.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* raw */ }
  if (!json) throw new Error('HTTP ' + resp.status + ' non-JSON: ' + text.slice(0, 200))
  return { status: resp.status, json }
}

function biz(res) {
  const d = res.json?.data
  if (res.json?.code !== 0 || d?.biz_code !== 0) {
    const err = new Error(d?.biz_msg || res.json?.msg || ('HTTP ' + res.status + ' code=' + res.json?.code + ' biz=' + d?.biz_code))
    err.bizCode = d?.biz_code ?? res.json?.code
    throw err
  }
  return d.biz_data
}

const out = obj => { process.stdout.write(JSON.stringify(obj) + '\n') }
const die = (msg, extra) => { process.stdout.write(JSON.stringify({ ok: false, error: String(msg && msg.message || msg), ...extra }) + '\n'); process.exit(0) }

// ---- ops ----
async function opCheck(args) {
  if (!args.token) return { ok: true, loggedIn: false }
  try {
    const res = await api('/api/v0/users/current', { token: args.token })
    const u = biz(res)?.user
    return { ok: true, loggedIn: true, account: { email: u?.email ?? null, mobile: u?.mobile_phone_number ?? null } }
  } catch (e) {
    return { ok: true, loggedIn: false, error: e.message }
  }
}

async function opLogin(args) {
  const deviceId = crypto.randomBytes(16).toString('hex')
  const body = { password: args.password, device_id: deviceId, os: 'web', email: '', mobile: '', area_code: '' }
  if ((args.email || '').includes('@')) body.email = args.email
  else { body.mobile = args.mobile || args.email || '', body.area_code = args.areaCode || '+86' }
  const res = await api('/api/v0/users/login', { method: 'POST', body, timeoutMs: 30000 })
  const user = biz(res)?.user
  if (!user?.token) throw new Error('login ok but no token')
  return { ok: true, token: user.token, account: { email: user.email ?? null, mobile: user.mobile_phone_number ?? null } }
}

function guessType(p) {
  p = String(p || '').toLowerCase()
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg'
  if (p.endsWith('.webp')) return 'image/webp'
  if (p.endsWith('.gif')) return 'image/gif'
  if (p.endsWith('.bmp')) return 'image/bmp'
  return 'image/png'
}

async function loadImages(images) {
  const parts = []
  for (const img of images) {
    if (img.path) {
      parts.push({ name: img.path.split('/').pop() || 'image', type: guessType(img.path), buf: fs.readFileSync(img.path) })
    } else if (img.url) {
      const r = await fetch(img.url, { signal: AbortSignal.timeout(60000) })
      if (!r.ok) throw new Error('download failed ' + img.url + ' HTTP ' + r.status)
      const buf = Buffer.from(await r.arrayBuffer())
      parts.push({ name: (img.url.split('/').pop() || 'image').split('?')[0], type: r.headers.get('content-type')?.split(';')[0] || 'image/png', buf })
    } else if (img.base64) {
      parts.push({ name: img.name || 'image.png', type: img.mime || 'image/png', buf: Buffer.from(img.base64, 'base64') })
    }
  }
  return parts
}

async function opAnalyze(args) {
  const token = args.token
  if (!token) throw new Error('not logged in')
  let images
  if (args.imagesStdin) {
    const arr = JSON.parse((await readStdin()).toString('utf8'))
    if (!Array.isArray(arr) || !arr.length) throw new Error('stdin images: expected non-empty JSON array')
    images = arr.map(x => ({ name: x.name || 'image.png', type: x.mime || 'image/png', buf: Buffer.from(x.b64, 'base64') }))
  } else {
    images = await loadImages(args.images || [])
  }
  if (!images.length) throw new Error('no readable images')
  const t0 = Date.now()
  // upload + fork each image
  const refIds = []
  for (const img of images) {
    const form = new FormData()
    form.append('file', new Blob([img.buf], { type: img.type }), img.name)
    const up = await api('/api/v0/file/upload_file', { method: 'POST', form, token, powFor: '/api/v0/file/upload_file', timeoutMs: 90000 })
    const fileId = biz(up)?.id
    if (!fileId) throw new Error('upload returned no file id')
    const fork = await api('/api/v0/file/fork_file_task', { method: 'POST', body: { file_id: fileId, to_model_type: 'vision' }, token, timeoutMs: 30000 })
    const forked = biz(fork)?.id ?? fileId
    refIds.push(forked)
  }
  // wait for parsing (best-effort, short)
  for (let i = 0; i < 8; i++) {
    try {
      const st = await api('/api/v0/file/fetch_files?file_ids=' + encodeURIComponent(refIds.join(',')), { token, timeoutMs: 20000 })
      const files = biz(st)?.files ?? []
      const bad = files.some(f => ['FAILED', 'ERROR', 'PARSE_FAILED'].includes(String(f.status || '').toUpperCase()))
      if (bad) throw new Error('file parsing failed on server')
      const allDone = files.length && files.every(f => !['PENDING', 'PARSING', 'UPLOADING', 'QUEUED'].includes(String(f.status || '').toUpperCase()))
      if (allDone) break
    } catch { /* polling errors are non-fatal */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  // fresh session
  const sess = await api('/api/v0/chat_session/create', { method: 'POST', body: {}, token, timeoutMs: 30000 })
  const chatSessionId = biz(sess)?.chat_session?.id ?? biz(sess)?.id
  if (!chatSessionId) throw new Error('no chat_session id')
  // completion (SSE)
  const DEFAULT_PROMPT = '请全面分析这张图片,分四部分回答:1) 整体描述:场景、主体、布局与显著视觉元素;2) 文字转写:逐字列出图中所有文字(界面文本、标签、数值、报错信息等),保持原文;3) 关键信息:值得注意的数据、UI 状态、异常或错误之处以及其他值得关注的细节;4) 推断:图片的类型、用途与上下文,以及用户可能想解决什么问题。用中文分条作答。'
  const body = {
    chat_session_id: chatSessionId,
    parent_message_id: null,
    model_type: 'vision',
    prompt: (args.prompt && args.prompt.trim()) ? args.prompt.trim() : DEFAULT_PROMPT,
    ref_file_ids: refIds,
    thinking_enabled: false,
    search_enabled: false,
  }
  const headers = { ...H, authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'text/event-stream', referer: BASE + '/a/chat/s/' + chatSessionId }
  let text = ''
  let rawTail = ''
  let deleted = false
  try {
    {
      const chResp = await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
        method: 'POST', headers: { ...H, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
      })
      const chText = await chResp.text()
      let ch = null
      try { ch = JSON.parse(chText)?.data?.biz_data?.challenge } catch { }
      if (!ch) throw new Error('completion PoW challenge failed: HTTP ' + chResp.status + ' ' + chText.slice(0, 200))
      headers['x-ds-pow-response'] = powHeader(ch)
    }
    headers['x-ds-session-id'] = chatSessionId
    const resp = await fetch(BASE + '/api/v0/chat/completion', {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300000),
    })
    if (resp.status !== 200) {
      const t = await resp.text()
      throw new Error('completion HTTP ' + resp.status + ': ' + t.slice(0, 200))
    }
    let activePath = null
    let sawFirst = false
    const rd = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await rd.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let obj
        try { obj = JSON.parse(payload) } catch { continue }
        const v = obj.v
        if (v && typeof v === 'object' && v.response) {
          for (const frag of (v.response.fragments || [])) {
            if (frag.type === 'RESPONSE' && frag.content) {
              if (!sawFirst) { sawFirst = true; text = frag.content } else text += frag.content
              activePath = 'response/fragments/-1/content'
            }
          }
        } else if (obj.p !== undefined) {
          activePath = obj.p
          if (obj.o === 'APPEND' && typeof v === 'string' && activePath.endsWith('content')) text += v
        } else if (typeof v === 'string' && activePath && activePath.endsWith('content')) {
          text += v
        }
      }
      rawTail = (rawTail + buf).slice(-1500)
    }
  } finally {
    // cleanup on EVERY path (success, stream error, timeout) — keep the web session list clean
    try {
      await api('/api/v0/chat_session/delete', { method: 'POST', body: { chat_session_id: chatSessionId }, token, timeoutMs: 15000 })
      deleted = true
    } catch { }
  }
  if (!text.trim()) throw new Error('empty vision response (stream ended without fragments); raw tail: ' + rawTail.slice(-800))
  // reference DSH's own content-addressed object store (no extra copies)
  const paths = []
  try {
    for (const im of images) {
      const sha = crypto.createHash('sha256').update(im.buf).digest('hex')
      const p = path.join(ATT_ROOT, 'objects', sha.slice(0, 2), sha)
      if (fs.existsSync(p)) paths.push(p)
    }
  } catch { /* best-effort */ }
  return { ok: true, text, images: images.length, paths, deleted, ms: Date.now() - t0 }
}

// ---- WeChat QR login (headless) ----
async function opWxQr() {
  const url = 'https://open.weixin.qq.com/connect/qrConnect?appid=' + WX_APPID + '&scope=snsapi_login&redirect_uri=' + WX_REDIRECT + '&state=&stylelite=1&fast_login=0'
  const resp = await fetch(url, { headers: { 'user-agent': UA, referer: BASE + '/' }, signal: AbortSignal.timeout(20000) })
  const html = await resp.text()
  const m = html.match(/connect\/qrcode\/([A-Za-z0-9_-]+)/) || html.match(/uuid=([A-Za-z0-9_-]+)/)
  if (!m) throw new Error('无法从微信 qrConnect 页面提取 uuid(HTTP ' + resp.status + ',len ' + html.length + ')')
  return { ok: true, uuid: m[1] }
}

async function opWxPoll(args) {
  if (!args.uuid) throw new Error('缺少 uuid')
  const resp = await fetch('https://long.open.weixin.qq.com/connect/l/qrconnect?uuid=' + encodeURIComponent(args.uuid) + '&last=' + (args.last || 404), {
    headers: { 'user-agent': UA, referer: 'https://open.weixin.qq.com/' },
    signal: AbortSignal.timeout(40000),
  })
  const text = await resp.text()
  const m = text.match(/wx_errcode=(\d+);\s*window\.wx_code='([^']*)'/)
  if (!m) throw new Error('轮询响应异常: ' + text.slice(0, 120))
  return { ok: true, errcode: Number(m[1]), code: m[2] || '' }
}

async function opWxLogin(args) {
  const code = (args.code || '').trim()
  if (!code) throw new Error('缺少微信授权 code')
  const cb = await fetch(BASE + '/api/v0/users/oauth/wechat/callback?code=' + encodeURIComponent(code) + '&state=', {
    redirect: 'manual',
    headers: { 'user-agent': UA, referer: BASE + '/', accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(30000),
  })
  const loc = cb.headers.get('location') || ''
  const q = new URLSearchParams(loc.split('?')[1] || '')
  const nonce = q.get('nonce')
  if (!nonce) throw new Error('微信换码失败(code=' + (q.get('code') || '?') + ',error=' + (q.get('error') || ('HTTP ' + cb.status + ' ' + loc.slice(0, 100))) + ')')
  const res = await api('/api/v0/users/oauth/get_token', { method: 'POST', body: { nonce: nonce, provider: 'WECHAT' }, timeoutMs: 30000 })
  const token = biz(res)?.token
  if (!token) throw new Error('get_token 未返回 token')
  let account = null
  try {
    const me = await api('/api/v0/users/current', { token, timeoutMs: 20000 })
    const u = biz(me)?.user
    account = { email: u?.email ?? null, mobile: u?.mobile_phone_number ?? null }
  } catch { }
  return { ok: true, token: token, account: account }
}

// ---- main ----
let args = {}
try {
  const raw = process.argv[2] || '{}'
  const s = /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length > 4 ? Buffer.from(raw, 'base64').toString('utf8') : raw
  args = JSON.parse(s)
} catch (e) { die('bad argv json: ' + e.message) }
try {
  if (args.op === 'check') out(await opCheck(args))
  else if (args.op === 'login') out(await opLogin(args))
  else if (args.op === 'analyze') out(await opAnalyze(args))
  else if (args.op === 'wxqr') out(await opWxQr(args))
  else if (args.op === 'wxpoll') out(await opWxPoll(args))
  else if (args.op === 'wxlogin') out(await opWxLogin(args))
  else die('unknown op: ' + args.op)
} catch (e) {
  die(e.message, { bizCode: e.bizCode ?? undefined })
}
