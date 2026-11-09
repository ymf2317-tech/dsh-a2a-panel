// dsh-a2a-panel — 浏览器半侧
//
// 本体是一个 iframe：直接跑 Agent2API 的原版面板（交互逻辑、页面、按钮全是原版），
// 由 host 半侧的 /a2a-panel/ui/* 同源反代提供，因此：
//   · 没有 https 页面嵌 http 的 mixed content 问题；
//   · 同源，父页面可以读 iframe 的 location，用于登录跳转后自动纠偏；
//   · 路径 shim 由反代注入到面板 HTML 里（见 host 侧 SHIM）。
//
// 三个坑（都踩过，别再退回去）：
//   1) 高度：DSH 主视图容器不保证有确定高度，只写 height:100% 会让 iframe 高度为 0 → 一片空白。
//      这里给 shell 一个 min-height 兜底，iframe 再撑满 body 层。
//   2) 首屏慢：面板要拉 2MB+ 的 JS 和接口数据，冷启动白屏几秒是真的在加载，需要可见的加载态。
//   3) 登录后 location.href='/' 会跳出反代前缀，iframe 变成 DSH 主页（白屏），需要自动重建。
try {
  window.__ModuleLoader__.load({
    id: 'dsh-a2a-panel',
    factory: (require) => {
      var module = { exports: {} }
      var exports = module.exports

      var React = null
      try { React = require('react') } catch (e) { /* fallback */ }
      if (!React) React = globalThis.React
      if (!React) throw new Error('dsh-a2a-panel: React runtime unavailable')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useRef = React.useRef
      var useCallback = React.useCallback

      var PANEL_ID = 'a2a-panel'
      var BASE = '/a2a-panel/ui'
      var NARROW_MAX = 820

      var CSS = [
        '.a2a-shell{display:flex;flex-direction:column;width:100%;box-sizing:border-box;',
        '  height:100%;min-height:calc(100dvh - 96px);}',
        '.a2a-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;flex:none;',
        '  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));',
        '  color:var(--dsw-alias-label-primary,inherit);font-size:12.5px;}',
        '.a2a-bar-t{font-weight:600;white-space:nowrap;}',
        '.a2a-bar-s{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.9));font-size:11.5px;',
        '  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.a2a-bar-r{margin-left:auto;display:flex;gap:6px;flex:none;}',
        '.a2a-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));',
        '  background:transparent;color:inherit;border-radius:8px;padding:3px 9px;font-size:12px;',
        '  cursor:pointer;line-height:1.6;}',
        '.a2a-btn:hover{background:var(--dsw-alias-bg-hover,rgba(127,127,127,.12));}',
        '.a2a-body{position:relative;flex:1 1 auto;min-height:320px;width:100%;}',
        '.a2a-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#fff;}',
        '.a2a-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;',
        '  justify-content:center;gap:10px;pointer-events:none;font-size:13px;',
        '  color:var(--dsw-alias-label-secondary,rgba(110,110,110,.95));}',
        '.a2a-spin{width:22px;height:22px;border-radius:50%;border:2px solid currentColor;',
        '  border-top-color:transparent;animation:a2a-rot 900ms linear infinite;opacity:.75;}',
        '@keyframes a2a-rot{to{transform:rotate(360deg)}}',
        '@media (max-width:820px){',
        '  .a2a-bar-s{display:none;}',
        '  .a2a-shell{min-height:calc(100dvh - 72px);}',
        '  .a2a-body{min-height:360px;}',
        '}',
      ].join('\n')

      function A2aPanel() {
        var frameRef = useRef(null)
        var shellRef = useRef(null)
        var tries = useRef(0)
        var _n = useState(false)
        var narrow = _n[0]
        var setNarrow = _n[1]
        var _s = useState(BASE + '/')
        var src = _s[0]
        var setSrc = _s[1]
        var _l = useState(false)
        var loaded = _l[0]
        var setLoaded = _l[1]

        var entry = narrow ? BASE + '/m/' : BASE + '/'

        useEffect(function () {
          var el = shellRef.current
          if (!el || typeof ResizeObserver === 'undefined') return
          var ro = new ResizeObserver(function (entries) {
            var item = entries && entries[0]
            var w = (item && item.contentRect && item.contentRect.width) || 0
            if (w > 0) setNarrow(w < NARROW_MAX)
          })
          ro.observe(el)
          return function () { ro.disconnect() }
        }, [])

        useEffect(function () {
          tries.current = 0
          setLoaded(false)
          setSrc(entry)
        }, [narrow])

        var onLoad = useCallback(function () {
          var f = frameRef.current
          if (!f || !f.contentWindow) return
          var loc
          try { loc = f.contentWindow.location } catch (e) { return }
          var path = loc.pathname || '/'
          if (path.indexOf(BASE) === 0) { tries.current = 0; setLoaded(true); return }
          // 跳出了反代前缀。常见来源：
          //   · 登录成功后 location.href='/'           → 映射成 /a2a-panel/ui/
          //   · 会话过期点「去登录」→ '/login?next=..'  → 映射成 /a2a-panel/ui/login?next=..
          // 关键是按「跳到了哪儿」把路径整体前缀化，而不是一律退回入口页，
          // 否则登录页会被弹回首页，首页又弹「会话已过期」，形成死循环。
          if (tries.current >= 8) { setLoaded(true); return }
          tries.current += 1
          setLoaded(false)
          var target = BASE + path + (loc.search || '') + (loc.hash || '')
          // 窄屏登录完跳回 '/' 时，别把人扔回桌面版
          if (narrow && (path === '/' || path === '/home')) {
            target = BASE + '/m/' + (loc.search || '') + (loc.hash || '')
          }
          setSrc(target)
        }, [narrow])

        var reload = useCallback(function () {
          tries.current = 0
          setLoaded(false)
          setSrc(entry + '?r=' + Date.now())
        }, [entry])

        var openNew = useCallback(function () {
          try { window.open(entry, '_blank', 'noopener') } catch (e) { /* ignore */ }
        }, [entry])

        return h('div', { className: 'a2a-shell', ref: shellRef }, [
          h('div', { className: 'a2a-bar', key: 'bar' }, [
            h('span', { className: 'a2a-bar-t', key: 't' }, 'Agent2API'),
            h('span', { className: 'a2a-bar-s', key: 's' }, narrow ? '手机版 · 原版面板' : '原版面板 · 同源反代'),
            h('div', { className: 'a2a-bar-r', key: 'r' }, [
              h('button', { className: 'a2a-btn', key: 'rf', onClick: reload, title: '重新加载面板' }, '刷新'),
              h('button', { className: 'a2a-btn', key: 'op', onClick: openNew, title: '在新标签页打开' }, '新窗口'),
            ]),
          ]),
          h('div', { className: 'a2a-body', key: 'body' }, [
            h('iframe', {
              key: src,
              ref: frameRef,
              className: 'a2a-frame',
              src: src,
              title: 'Agent2API',
              onLoad: onLoad,
              allow: 'clipboard-read; clipboard-write',
            }),
            loaded ? null : h('div', { className: 'a2a-loading', key: 'ld' }, [
              h('div', { className: 'a2a-spin', key: 'sp' }),
              h('span', { key: 'tx' }, '正在加载 Agent2API 面板…'),
            ]),
          ]),
        ])
      }

      function A2aIcon(props) {
        var size = (props && props.size) || 20
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
          style: { flex: 'none' },
        }, [
          h('rect', { key: 'a', x: '2.5', y: '4', width: '19', height: '6', rx: '2' }),
          h('rect', { key: 'b', x: '2.5', y: '14', width: '19', height: '6', rx: '2' }),
          h('circle', { key: 'c', cx: '6.5', cy: '7', r: '0.9', fill: 'currentColor', stroke: 'none' }),
          h('circle', { key: 'd', cx: '6.5', cy: '17', r: '0.9', fill: 'currentColor', stroke: 'none' }),
        ])
      }

      function apply(ctx) {
        var styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsh-a2a-panel', '')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        ctx.effect(function () {
          return function () { styleEl.remove() }
        }, 'dsh-a2a-panel: styles')

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_ID }, A2aPanel)
        })
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 8,
            label: function () { return 'Agent2API' },
          }, A2aIcon)
        })
      }

      exports.apply = apply
      exports.inject = ['slots']
      return module.exports
    },
  })
} catch (error) {
  var msg = String((error && error.message) || error)
  if (!/duplicate factory registration/.test(msg)) throw error
}
