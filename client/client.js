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
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const FIELD_ORDER = ['allowWxids', 'allowGroups', 'bootstrap', 'approvalMode', 'idleAwayMinutes', 'answerTimeoutMs']
    const FIELD_LABELS = {
      allowWxids: '授权白名单（空格分隔；空 = 拒绝所有人）',
      allowGroups: '响应群聊消息（发送者需在白名单并 @机器人）',
      bootstrap: '引导模式（只回复来信号 id，不执行指令）',
      approvalMode: "审批通道（'wechat-driven' | 'all'）",
      idleAwayMinutes: '键鼠空闲多少分钟判定离席',
      answerTimeoutMs: '微信审批超时（毫秒，超时回退 GUI）',
    }

    const box = { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '12px 14px', margin: '8px 0' }
    const labelStyle = { display: 'block', fontSize: 13, margin: '10px 0 4px' }
    const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.5)', background: 'transparent', color: 'inherit' }
    const buttonStyle = { marginTop: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(128,128,128,.5)', background: 'transparent', color: 'inherit', cursor: 'pointer' }

    /** Subscribe to one settings form; re-renders on every snapshot change. */
    function useConfigForm(ctx, namespace) {
      const form = ctx.configForms?.get(namespace)
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
        return h('div', { style: box }, state?.status === 'loading' ? '正在读取配置…' : '配置暂不可用')
      }
      const keys = FIELD_ORDER.filter((k) => Object.hasOwn(value, k))
      const currentDraft = draft ?? {}
      const fieldDraft = (k) => (Object.hasOwn(currentDraft, k) ? currentDraft[k]
        : Array.isArray(value[k]) ? value[k].join(' ') : String(value[k]))
      const parse = (k, raw) => {
        if (Array.isArray(value[k])) return raw.trim() === '' ? [] : raw.trim().split(/\s+/)
        if (typeof value[k] === 'boolean') return raw === 'true'
        if (typeof value[k] === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : raw }
        return raw
      }
      const save = async () => {
        let changed = 0
        try {
          for (const k of keys) {
            const parsed = parse(k, fieldDraft(k))
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
      return h('div', { style: box, 'data-wechat-config': 'form' },
        headline ? h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, headline) : null,
        keys.map((k) => h('label', { key: k, style: labelStyle },
          FIELD_LABELS[k] ?? k,
          h('input', {
            style: inputStyle,
            value: fieldDraft(k),
            onChange: (e) => setDraft({ ...currentDraft, [k]: e.target.value }),
          }))),
        h('div', null,
          h('button', { type: 'button', style: buttonStyle, onClick: () => { void save() } }, '保存'),
          h('button', { type: 'button', style: { ...buttonStyle, marginLeft: 8 }, onClick: () => { setDraft(null); setNote('已还原') } }, '还原'),
          note ? h('span', { style: { marginLeft: 10, fontSize: 13 } }, note) : null))
    }

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

    /** Bundle-page inline form: self-fed from the settings namespace. */
    function BundleConfigView(props) {
      const form = useConfigForm(this.ctx, 'wechat-workbench')
      return h(ConfigFields, { ...props, form, headline: '微信工作台配置（保存即热生效）' })
    }

    /** Row 「配置」 page: the plugin manager passes the form as props. */
    function RowConfigView(props) {
      const selfForm = useConfigForm(this.ctx, 'wechat-workbench')
      return h(ConfigFields, { view: props.view, form: asForm(props.form) ?? selfForm })
    }

    const STATE_TEXT = { connecting: '连接中…', login: '等待扫码登录', ready: '已连接', error: '错误' }

    function DetailSection(props) {
      const pkgName = props.subject?.pkg?.name ?? props.subject?.pkg
      const [status, setStatus] = useState(null)
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
      if (pkgName !== 'dsh-wechat-workbench') return null
      return h('div', { style: box, 'data-wechat-status': status?.state ?? 'unknown' },
        h('div', { style: { fontSize: 13, fontWeight: 600 } },
          `微信通道：${STATE_TEXT[status?.state] ?? status?.state ?? '…'}`),
        status?.state === 'login'
          ? h('div', { style: { marginTop: 8, textAlign: 'center' } },
            status.qrPng
              ? h('img', { src: `data:image/png;base64,${status.qrPng}`, alt: '登录二维码', style: { width: 220, height: 220 } })
              : null,
            h('div', { style: { fontSize: 12, marginTop: 6 } },
              '用微信扫码绑定（或',
              h('a', { href: status.qrUrl ?? '#', target: '_blank', rel: 'noreferrer' }, '打开链接'),
              '）。扫过一次后令牌持久化，重启免扫码。'))
          : null,
        status?.state === 'error' && status.message
          ? h('div', { style: { fontSize: 12, marginTop: 6, opacity: .8 } }, String(status.message))
          : null,
        status?.state === 'ready'
          ? h('div', { style: { fontSize: 12, marginTop: 6, opacity: .8 } },
            `白名单 ${status.allowWxids?.length ?? 0} 人 · 审批：${status.approvalMode === 'all' ? '所有会话（离席时）' : '仅微信驱动会话'} · ${status.atDesk ? '当前在电脑前' : '当前离席'}`)
          : null)
    }

    module.exports = {
      name: 'dsh-wechat-workbench-ui',
      inject: ['slots', 'configForms'],
      apply(ctx) {
        // Warm the shared settings mirror so form gates hold before any
        // settings page has been opened.
        ctx.configForms.describe().ensure?.()?.catch?.(() => {})
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
        ctx.effect(() => ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
          { name: 'plugins.detail.section', id: 'wechat-workbench-status' },
          DetailSection,
        ), 'wechat-workbench client: detail section'))
      },
    }
    return module.exports
  },
})
