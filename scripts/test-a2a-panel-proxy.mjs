// 把 dsh-a2a-panel 的 host 半侧挂到一个临时 http 服务上，
// 验证 /a2a-panel/ui/* 整站反代是否工作——不碰正在运行的 DSH。
//
// 用法：
//   node scripts/test-a2a-panel-proxy.mjs
//   # 另开一个终端
//   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3099/a2a-panel/ui/login
//   curl -s -D - -o /dev/null http://127.0.0.1:3099/a2a-panel/ui/ | grep -i location
//
// 环境变量：
//   A2A_BASE        Agent2API 地址，默认 http://127.0.0.1:3065
//   A2A_GATEWAY_KEY 可选，网关 Key（面板的 /api/accounts 等需要）
//   PORT            临时端口，默认 3099
import http from 'node:http'
import { apply } from '../lib/index.js'

const apiBase = process.env.A2A_BASE || 'http://127.0.0.1:3065'
const gatewayKey = process.env.A2A_GATEWAY_KEY || ''
const port = Number(process.env.PORT || 3099)

const routes = []
const ctx = {
  webServer: {
    register(opts) {
      routes.push(opts)
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}

apply(ctx, { apiBase, gatewayKey, timeoutMs: 20000 })

console.log('routes:', routes.map((r) => r.path).join(', '))
if (!gatewayKey) console.log('note: A2A_GATEWAY_KEY 未设置，/api/accounts 这类接口可能返回 401（面板 UI 靠 cookie 登录，不受影响）')

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0]
  const hit = routes.find((t) => path.startsWith(t.path))
  if (!hit) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('no route for ' + path)
  }
  try {
    await hit.handler(req, res)
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('handler threw: ' + String((error && error.message) || error))
    } else {
      try { res.end() } catch {}
    }
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log('READY http://127.0.0.1:' + port)
})
