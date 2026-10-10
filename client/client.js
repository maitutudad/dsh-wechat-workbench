/**
 * dsh-wechat-workbench — browser companion.
 *
 * Closure-factory artifact: registers itself with the page's module loader
 * (`window.__ModuleLoader__.load`) and resolves externals (React) through the
 * injected module table. Contributes to the Web workbench's 「插件」 panel:
 *
 *  - `plugins.bundle.config` keyed `dsh-wechat-workbench`: the configuration
 *    form rendered inline on the bundle's detail page (self-fed from the
 *    shared settings namespace through the `configForms` service).
 *  - `plugins.row.config` keyed `dsh-wechat-workbench#wechat-workbench`: the
 *    same form behind the row's 「配置」 control (values arrive as props).
 *  - `plugins.detail.section`: WeChat login QR and connection status, polled
 *    from the authenticated `/api/wechat-workbench/status` route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-workbench',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    const React = require('react')
    const { Button, Input, Switch, SegmentedControl } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const FIELD_ORDER = ['allowWxids', 'bootstrap', 'approvalMode', 'idleAwayMinutes', 'answerTimeoutMs']
    const FIELD_LABELS = {
      allowWxids: '授权白名单（空格分隔；空 = 拒绝所有人）',
      bootstrap: '首次绑定助手',
      approvalMode: '哪些提问会推到微信',
      idleAwayMinutes: '离开电脑判定（键鼠空闲分钟数）',
      answerTimeoutMs: '微信提问等待回复（毫秒，超时转回网页）',
    }
    const FIELD_HINTS = {
      bootstrap: '开启后，用微信给机器人发任意消息，它会回复你的微信 ID；把 ID 填进上方白名单后关闭本项。',
    }
    const MODE_LABELS = { 'wechat-driven': '仅微信里发起的会话', 'all': '离开电脑后全部会话' }
    const MODE_HINTS = {
      'wechat-driven': '只有从微信发起的会话需要你决定时才推微信；网页里发起的会话，提问留在网页等你看。',
      'all': '键鼠空闲超过上面的分钟数后，任何会话（含网页发起）的提问都推到微信，手机上回复即可；回到电脑自动恢复网页。',
    }

    // No chrome of our own: the plugin page already frames each detail
    // section, so the companion renders content only.
    const labelStyle = { display: 'block', fontSize: 12, opacity: .85, marginBottom: 6 }

    /** Subscribe to one settings form; re-renders on every snapshot change. */
    function useConfigForm(ctx, namespace) {
      const form = ctx.get?.('configForms')?.get(namespace)
      const [, force] = useState(0)
      useEffect(() => form?.subscribe(() => force(n => n + 1)) ?? undefined, [form])
      return form
    }

    /** The editable field list over one ConfigForm; saves changed fields with form.set. */
    function ConfigFields(props) {
      const { form, headline } = props
      const state = form?.getSnapshot()
      const value = state?.value
      const [draft, setDraft] = useState(null)
      const [note, setNote] = useState(null)
      if (props.view === 'summary') {
        return h('span', null, value == null ? '微信工作台配置' : `${FIELD_ORDER.length} 个可热更新字段`)
      }
      if (form === undefined || value === undefined) {
        return h('div', { style: { opacity: .7 } }, state?.status === 'loading' ? '正在读取配置…' : '配置暂不可用')
      }
      const keys = FIELD_ORDER.filter((k) => Object.hasOwn(value, k))
      const currentDraft = draft ?? {}
      const hasDraft = (k) => Object.hasOwn(currentDraft, k)
      const boolValue = (k) => (hasDraft(k) ? currentDraft[k] : Boolean(value[k]))
      const textValue = (k) => (hasDraft(k) ? currentDraft[k]
        : Array.isArray(value[k]) ? value[k].join(' ') : String(value[k]))
      const modeValue = () => (hasDraft('approvalMode') ? currentDraft.approvalMode : value.approvalMode)
      const parse = (k, raw) => {
        if (Array.isArray(value[k])) return raw.trim() === '' ? [] : raw.trim().split(/\s+/)
        if (typeof value[k] === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : raw }
        return raw
      }
      const save = async () => {
        let changed = 0
        try {
          for (const k of keys) {
            let parsed
            if (typeof value[k] === 'boolean') parsed = boolValue(k)
            else if (k === 'approvalMode') parsed = modeValue()
            else parsed = parse(k, textValue(k))
            if (JSON.stringify(parsed) !== JSON.stringify(value[k])) {
              const ok = await form.set(k, parsed)
              if (!ok) throw new Error('主机拒绝了写入')
              changed += 1
            }
          }
          setDraft(null)
          setNote(changed === 0 ? '没有改动' : `已保存 ${changed} 项（热生效）`)
        } catch (error) {
          setNote(`保存失败：${String(error?.message ?? error)}`)
        }
      }
      return h('div', { 'data-wechat-config': 'form', style: { display: 'grid', gap: 12, marginTop: 8 } },
        headline ? h('div', { style: { fontSize: 13, fontWeight: 600 } }, headline) : null,
        ...keys.map((k) => {
          if (typeof value[k] === 'boolean') {
            // The primitive's Switch takes an aria-label only; lay out the
            // visible text beside the toggle ourselves, rows-style.
            return h('div', { key: k },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 } },
                h('span', { style: { flex: 1 } }, FIELD_LABELS[k] ?? k),
                h(Switch, {
                  checked: boolValue(k), label: FIELD_LABELS[k] ?? k,
                  onChange: (next) => setDraft({ ...currentDraft, [k]: next }),
                })),
              FIELD_HINTS[k] && boolValue(k) === false ? h('div', { style: { fontSize: 12, opacity: .7, marginTop: 2 } }, FIELD_HINTS[k]) : null)
          }
          if (k === 'approvalMode') {
            return h('div', { key: k },
              h('span', { style: labelStyle }, FIELD_LABELS[k] ?? k),
              h(SegmentedControl, {
                value: modeValue(),
                options: [
                  { value: 'wechat-driven', label: MODE_LABELS['wechat-driven'] },
                  { value: 'all', label: MODE_LABELS['all'] },
                ],
                onChange: (v) => setDraft({ ...currentDraft, approvalMode: v }),
              }),
              h('div', { style: { fontSize: 12, opacity: .7, marginTop: 4 } }, MODE_HINTS[modeValue()] ?? ''))
          }
          return h('label', { key: k, style: labelStyle },
            FIELD_LABELS[k] ?? k,
            h(Input, {
              type: typeof value[k] === 'number' ? 'number' : 'text',
              value: textValue(k),
              onChange: (e) => setDraft({ ...currentDraft, [k]: e.target.value }),
              style: { width: '100%' },
            }))
        }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(Button, { variant: 'outline', size: 'sm', onClick: () => { void save() } }, '保存'),
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => { setDraft(null); setNote('已还原') } }, '还原'),
          note ? h('span', { style: { fontSize: 13, opacity: .8 } }, note) : null))
    }

    const STATE_TEXT = { connecting: '连接中…', login: '等待扫码登录', ready: '已连接', error: '错误' }

    /** Normalize the two form shapes: a live ConfigForm, or the page's { state, mutate }. */
    function asForm(f) {
      if (f === undefined || f === null) return undefined
      if (typeof f.getSnapshot === 'function') return f
      if (f.state !== undefined) {
        return {
          getSnapshot: () => f.state,
          set: (field, value) => f.mutate([{ op: 'set', path: [field], value }], f.state.revision),
        }
      }
      return undefined
    }

    /** Bundle-page panel: connection status/QR above the live config form. */
    function BundleConfigView(props) {
      const form = useConfigForm(this.ctx, 'wechat-workbench')
      return h('div', null,
        h(StatusLine, null),
        h(ConfigFields, { ...props, form, headline: '微信工作台配置（保存即热生效）' }))
    }

    /** Row 「配置」 page: the plugin manager passes the form as props. */
    function RowConfigView(props) {
      const selfForm = useConfigForm(this.ctx, 'wechat-workbench')
      return h(ConfigFields, { view: props.view, form: asForm(props.form) ?? selfForm })
    }

    /** Connection status / login QR plus reconnect controls. */
    function StatusLine(props) {
      const [status, setStatus] = useState(null)
      const [pending, setPending] = useState(null) // null | 'reconnect' | 'logout'
      const act = async (action) => {
        setPending(action)
        try {
          await fetch('/api/wechat-workbench/status', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
        } catch { /* the next poll reports the outcome */ }
      }
      // A pending action clears once the polled state settles somewhere new.
      useEffect(() => {
        if (pending === null) return
        if (status?.state === 'ready' || status?.state === 'login') setPending(null)
      }, [status?.state, pending])
      useEffect(() => {
        if (pending === null) return
        const timer = setTimeout(() => setPending(null), 20_000)
        return () => { clearTimeout(timer) }
      }, [pending])
      useEffect(() => {
        const poll = async () => {
          try {
            const r = await fetch('/api/wechat-workbench/status')
            setStatus(r.ok ? await r.json() : { state: 'error', message: `HTTP ${r.status}` })
          } catch (error) {
            setStatus({ state: 'error', message: String(error) })
          }
        }
        void poll()
        const timer = setInterval(() => { void poll() }, 3000)
        return () => { clearInterval(timer) }
      }, [])
      return h('div', { 'data-wechat-status': status?.state ?? 'unknown' },
        h('div', { style: { fontSize: 13, fontWeight: 600 } },
          `微信通道：${STATE_TEXT[status?.state] ?? status?.state ?? '…'}`),
        status?.state === 'login'
          ? h('div', { style: { marginTop: 8, textAlign: 'center' } },
            status.qrSvg
              ? h('img', { src: `data:image/svg+xml;base64,${status.qrSvg}`, alt: '登录二维码', style: { width: 220, height: 220, background: '#fff', borderRadius: 8 } })
              : null,
            h('div', { style: { fontSize: 12, marginTop: 6 } },
              '用微信扫码绑定（或',
              h('a', { href: status.qrUrl ?? '#', target: '_blank', rel: 'noreferrer' }, '打开链接'),
              '）。扫过一次后令牌持久化，重启免扫码。'),
            h('div', { style: { fontSize: 12, marginTop: 4, opacity: .7 } },
              '二维码过期会自动换新', status.qrAt ? `（当前这版 ${Math.max(0, Math.round((Date.now() - status.qrAt) / 1000))} 秒前更新）` : ''),
            h(Button, {
              variant: 'ghost', size: 'sm', disabled: pending !== null,
              title: '立即重新生成二维码（过期也会自动换新）',
              onClick: () => { void act('reconnect') },
            }, pending === 'reconnect' ? '刷新中…' : '刷新二维码'))
          : null,
        status?.state === 'error' && status.message
          ? h('div', { style: { fontSize: 12, marginTop: 6, opacity: .8 } }, String(status.message))
          : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
          status?.state === 'ready'
            ? h('span', { style: { fontSize: 12, opacity: .8 } },
              `白名单 ${status.allowWxids?.length ?? 0} 人 · 审批：${status.approvalMode === 'all' ? '所有会话（离席时）' : '仅微信驱动会话'} · ${status.atDesk ? '当前在电脑前' : '当前离席'}`)
            : null,
          status?.state === 'ready' || status?.state === 'error'
            ? h(Button, {
              variant: 'outline', size: 'sm', disabled: pending !== null,
              title: '重启传输进程；保留登录令牌，通常免扫码恢复',
              onClick: () => { void act('reconnect') },
            }, pending === 'reconnect' ? '重连中…' : '重新连接')
            : null,
          status?.state === 'ready'
            ? h(Button, {
              variant: 'outline', size: 'sm', disabled: pending !== null,
              title: '清除本机登录令牌并断开；重连后面板显示新二维码，需重新扫码（换绑微信也用它）',
              onClick: () => { if (window.confirm('清除登录令牌并断开？重连后需要重新扫码绑定。')) void act('logout') },
            }, pending === 'logout' ? '等待重扫…' : '解绑并重新扫码')
            : null))
    }

    module.exports = {
      name: 'dsh-wechat-workbench-ui',
      inject: ['slots'],
      apply(ctx) {
        // Warm the shared settings mirror so form gates hold before any
        // settings page has been opened.
        const configForms = ctx.get?.('configForms')
        configForms?.describe?.().ensure?.()?.catch?.(() => {})
        const bundleView = BundleConfigView.bind({ ctx })
        const rowView = RowConfigView.bind({ ctx })
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-wechat-workbench' },
          bundleView,
        ), 'wechat-workbench client: bundle config'))
        ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
          { name: 'plugins.row.config', key: 'dsh-wechat-workbench#wechat-workbench' },
          rowView,
        ), 'wechat-workbench client: row config'))
      },
    }
    return module.exports
  },
})
