// dsh-a2a-panel — host 半侧
//
// 两个职责：
//   1) /a2a-panel/ui/*  —— 把 Agent2API 的整套面板（HTML/JS/CSS/API）同源反代进来，
//      让前端可以用 iframe 直接跑「原版网页」，交互全部是原版逻辑。
//      反代时做三件改写：
//        · HTML 注入 shim：把页面里绝对路径的 /api/... 改写到 /a2a-panel/ui/api/...，
//          并给 <a href="/x"> 补前缀——否则这些请求会打到 DSH 自己身上；
//        · 302 的 Location: /login 补前缀，否则登录会跳出 iframe 落到 DSH 根；
//        · Set-Cookie 的 Path 收到 /a2a-panel/ui，避免污染 DSH 自身会话。
//      同时注入一层皮肤 CSS（SKIN），不改上游文件、升级不被覆盖。
//   2) /a2a-panel/api/snapshot —— 汇总快照（看板备用，接口保留）。
//
// 为什么必须走 host 反代而不是 iframe 直连 http://<ip>:3065：
//   DSH 从 https://<tailnet 域名>/ 打开，https 页面里嵌 http 的 iframe 会被
//   浏览器按 mixed content 直接拦掉；跨源的 iframe 也无法注入 CSS。

export const name = 'dsh-a2a-panel'
export const inject = ['webServer']

const PREFIX_API = '/a2a-panel/api'
const PREFIX_UI = '/a2a-panel/ui'
const DEFAULT_BASE = 'http://127.0.0.1:3065'
const CACHE_TTL_MS = 3000

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function errText(payload) {
  if (!payload) return ''
  const e = payload.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object') return String(e.message || e.type || JSON.stringify(e))
  if (payload.message) return String(payload.message)
  return ''
}

async function readBody(req, limit) {
  const cap = limit || 8 * 1024 * 1024
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/* 注入到面板页面里的 shim：必须在其它脚本之前执行 */
const SHIM = [
  '(function(){',
  '  var P="' + PREFIX_UI + '";',
  '  var inM=(location.pathname.indexOf(P+"/m/")===0||location.pathname===P+"/m");',
  '  function fix(u){',
  '    if(typeof u!=="string") return u;',
  '    if(u.charAt(0)!=="/") return u;',
  '    if(u.indexOf(P)===0) return u;',
  '    if(u.indexOf("/api/")===0) return P+u;',
  '    if(inM) return P+"/m"+u;',
  '    return P+u;',
  '  }',
  '  var of=window.fetch;',
  '  if(of){ window.fetch=function(u,o){ return of.call(this,fix(u),o) } }',
  '  var XO=XMLHttpRequest.prototype.open;',
  '  XMLHttpRequest.prototype.open=function(m,u){',
  '    if(arguments.length>1) arguments[1]=fix(u);',
  '    return XO.apply(this,arguments)',
  '  };',
  '  var OS=window.EventSource;',
  '  if(OS){ window.EventSource=function(u,c){ return new OS(fix(u),c) } }',
  '  try{',
  '    var L=window.location;',
  '    var oa=L.assign&&L.assign.bind(L);',
  '    var or=L.replace&&L.replace.bind(L);',
  '    if(oa) L.assign=function(u){ return oa(fix(u)) };',
  '    if(or) L.replace=function(u){ return or(fix(u)) };',
  '  }catch(e){}',
  '  document.addEventListener("click",function(e){',
  '    var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;',
  '    if(!a) return;',
  '    var h=a.getAttribute("href");',
  '    if(h&&h.charAt(0)==="/"&&h.indexOf(P)!==0){ e.preventDefault(); location.href=fix(h) }',
  '  },true);',
  '})();',
].join('\n')

function injectIntoHtml(html) {
  let out = html
  // shim 越早越好：紧跟 <head> 之后
  const tag = '<base href="' + PREFIX_UI + '/">\n<script data-dsh-a2a-shim>' + SHIM + '</script>'
  const headOpen = out.match(/<head[^>]*>/i)
  if (headOpen && headOpen.index !== undefined) {
    const at = headOpen.index + headOpen[0].length
    out = out.slice(0, at) + '\n' + tag + out.slice(at)
  } else {
    out = tag + out
  }
  return out
}

export function apply(ctx, config) {
  const cfg = config || {}
  const apiBase = String(cfg.apiBase || DEFAULT_BASE).replace(/\/+$/, '')
  const gatewayKey = String(process.env.A2A_GATEWAY_KEY || cfg.gatewayKey || '').trim()
  const timeoutMs = Number(cfg.timeoutMs || 15000)

  /* ---------------- 1) 整站同源反代 ---------------- */

  async function proxyPanel(req, res) {
    const url = new URL(req.url || '/', 'http://dsh.internal')
    let tail = url.pathname.slice(PREFIX_UI.length)
    if (tail === '') tail = '/'
    const target = apiBase + tail + (url.search || '')

    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase()
      if (key === 'host' || key === 'connection' || key === 'content-length' || key === 'accept-encoding') continue
      headers[key] = v
    }
    headers['accept-encoding'] = 'identity'

    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req)

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })

    const outHeaders = {}
    for (const [k, v] of upstream.headers.entries()) {
      const key = k.toLowerCase()
      if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') continue
      if (key === 'location' && v.startsWith('/')) {
        outHeaders.location = PREFIX_UI + v
        continue
      }
      if (key === 'set-cookie') {
        // 收窄 cookie 作用域，别让它跟着 DSH 自己的请求跑
        outHeaders['set-cookie'] = String(v).replace(/Path=\/(?!a2a-panel)/i, 'Path=' + PREFIX_UI + '/')
        continue
      }
      outHeaders[key] = v
    }

    const buf = Buffer.from(await upstream.arrayBuffer())
    const type = String(outHeaders['content-type'] || '')
    if (type.includes('text/html')) {
      const html = injectIntoHtml(buf.toString('utf8'))
      const out = Buffer.from(html, 'utf8')
      outHeaders['content-length'] = String(out.length)
      res.writeHead(upstream.status, outHeaders)
      res.end(out)
      return
    }
    outHeaders['content-length'] = String(buf.length)
    res.writeHead(upstream.status, outHeaders)
    res.end(buf)
  }

  /* ---------------- 2) 汇总快照（备用看板） ---------------- */

  async function call(path) {
    const headers = {}
    if (gatewayKey) headers.authorization = 'Bearer ' + gatewayKey
    const res = await fetch(apiBase + path, { headers, signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text.slice(0, 400) }
    }
    if (!res.ok) throw new Error(path + ' → HTTP ' + res.status + ' ' + errText(payload))
    return payload
  }

  function providerIndex(keysPayload) {
    const map = new Map()
    const list = (keysPayload && keysPayload.data && keysPayload.data.providers) || []
    for (const p of list) if (p && p.id) map.set(String(p.id), String(p.label || p.id))
    return map
  }

  function shapeAccounts(accountsPayload, providers) {
    const raw = (accountsPayload && accountsPayload.data && accountsPayload.data.accounts) || []
    const rows = raw.map(function (a) {
      const rateLimits = a.rateLimits || {}
      const limitedModels = Object.keys(rateLimits).filter(function (m) {
        const r = rateLimits[m]
        return r && (r.status === 429 || (r.resetAt && Number(r.resetAt) > Date.now()))
      })
      return {
        id: String(a.id || a.uid || a.name || ''),
        name: String(a.name || a.displayName || '未命名'),
        provider: String(a.provider || ''),
        providerLabel: providers.get(String(a.provider || '')) || String(a.provider || ''),
        editionLabel: String(a.editionLabel || ''),
        enabled: !!a.enabled,
        available: !!a.available,
        needsRelogin: !!a.needsRelogin,
        reloginReason: String(a.needsReloginReason || ''),
        priority: Number(a.priority || 0),
        expiresAt: Number(a.expiresAt || a.expiresAtMs || 0),
        checkedInToday: !!a.checkedInToday,
        limitedModels: limitedModels,
        limitedCount: limitedModels.length,
      }
    })
    return {
      rows: rows,
      summary: {
        total: rows.length,
        enabled: rows.filter(function (r) { return r.enabled }).length,
        available: rows.filter(function (r) { return r.available }).length,
        limited: rows.filter(function (r) { return r.limitedCount > 0 }).length,
        relogin: rows.filter(function (r) { return r.needsRelogin }).length,
      },
    }
  }

  function shapeModels(keysPayload) {
    const data = (keysPayload && keysPayload.data) || {}
    const byProvider = data.modelsByProvider || {}
    const out = []
    Object.keys(byProvider).forEach(function (provider) {
      for (const id of byProvider[provider] || []) out.push({ id: String(id), provider: String(provider) })
    })
    out.sort(function (a, b) { return a.id.localeCompare(b.id) })
    return out
  }

  let cache = { at: 0, value: null, inflight: null }

  async function buildSnapshot() {
    const settled = await Promise.allSettled([
      call('/health'),
      call('/api/accounts'),
      call('/api/keys'),
      call('/api/logs?limit=1'),
    ])
    const problems = []
    function pick(i, label) {
      const s = settled[i]
      if (s.status === 'fulfilled') return s.value
      problems.push(label + ': ' + String((s.reason && s.reason.message) || s.reason))
      return null
    }
    const health = pick(0, 'health')
    const accountsPayload = pick(1, 'accounts')
    const keysPayload = pick(2, 'keys')
    const logsPayload = pick(3, 'logs')
    const providers = providerIndex(keysPayload)
    const accounts = shapeAccounts(accountsPayload, providers)
    const data = (keysPayload && keysPayload.data) || {}
    return {
      ok: problems.length === 0,
      at: Date.now(),
      base: apiBase,
      gateway: { status: (health && health.status) || (problems.length ? 'unreachable' : 'unknown'), keyConfigured: gatewayKey.length > 0 },
      summary: accounts.summary,
      accounts: accounts.rows,
      keys: (data.keys || []).map(function (k) {
        return { id: String(k.id || ''), name: String(k.name || ''), masked: String(k.masked || ''), enabled: !!k.enabled }
      }),
      models: shapeModels(keysPayload),
      logs: (function () {
        const l = (logsPayload && logsPayload.data && logsPayload.data.byLevel) || {}
        return { error: Number(l.error || 0), warn: Number(l.warn || 0), info: Number(l.info || 0) }
      })(),
      problems: problems,
    }
  }

  async function snapshot() {
    if (cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
    if (cache.inflight) return cache.inflight
    cache.inflight = buildSnapshot()
      .then(function (value) {
        cache = { at: Date.now(), value: value, inflight: null }
        return value
      })
      .catch(function (error) {
        cache.inflight = null
        throw error
      })
    return cache.inflight
  }

  /* ---------------- 路由 ---------------- */

  const disposeUi = ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX_UI,
    handler: async function (req, res) {
      try {
        await proxyPanel(req, res)
      } catch (error) {
        if (res.headersSent) {
          try { res.end() } catch { /* ignore */ }
          return
        }
        sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  const disposeApi = ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX_API,
    handler: async function (req, res) {
      const url = new URL(req.url || '/', 'http://dsh.internal')
      const tail = url.pathname.slice(PREFIX_API.length).replace(/^\/+/, '')
      try {
        if (tail === 'snapshot') return sendJson(res, 200, await snapshot())
        if (tail === 'health' || tail === '') {
          const value = await snapshot()
          return sendJson(res, 200, { ok: true, gateway: value.gateway, at: value.at })
        }
        return sendJson(res, 404, { ok: false, error: 'unknown method "' + tail + '"' })
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  ctx.effect(function () {
    return function () {
      try { disposeUi() } catch { /* already disposed */ }
      try { disposeApi() } catch { /* already disposed */ }
    }
  }, 'dsh-a2a-panel: HTTP routes')

  console.log('[dsh-a2a-panel] proxy ' + PREFIX_UI + ' → ' + apiBase + (gatewayKey ? ' (gateway key set)' : ' (no key)'))
}
