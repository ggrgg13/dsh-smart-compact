/**
 * @local/dsh-smart-compact — Client half.
 *
 * Two seats:
 *
 * - `conversation.input.model.options` — one row in the model/reasoning menu
 *   showing used context against this session's suggested line; expanding it
 *   reveals the threshold controls.
 * - `plugins.bundle.config` — the plugin page's default-threshold control.
 *
 * No build step: DSH loads this file as a Cordis client bundle through the
 * `dsh.client` declaration in package.json.
 *
 * Writes go through the Host's `/smart-compact/*` routes. The live usage number
 * rides the `contextPressure` projection supplied by the slot props
 * (`useProjection`), so the row updates without polling.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-smart-compact',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'smart-compact'
    const STATE_PATH = '/smart-compact/state'
    const SESSION_PATH = '/smart-compact/session'
    const DEFAULT_PATH = '/smart-compact/default'

    const en = {
      'row.label': 'Context compaction',
      'row.off': 'off',
      'row.unavailable': '—',
      'panel.open': 'Change the compaction threshold',
      'panel.used': 'Used',
      'panel.suggested': 'Suggested line',
      'panel.system': 'System line',
      'panel.follow': 'Follow the default ({percent}%)',
      'panel.custom': 'Custom',
      'panel.off': 'Off',
      'panel.offHint': 'The system line still applies.',
      'panel.cap': 'up to {percent}%',
      'panel.saving': 'Saving…',
      'panel.saveFailed': 'Could not save: {message}',
      'panel.windowTooSmall': 'This model leaves no room below the system line, so no suggestion is made.',
      'panel.unknownWindow': 'The context window is known after the first request.',
      'panel.capped': 'The system line caps this at {percent}%.',
      'panel.unavailable': 'Settings are unavailable right now. Reload the page to retry.',
      'panel.retry': 'Retry',
      'settings.title': 'Default compaction threshold',
      'settings.description': 'New sessions start here; a session can override it from the model menu.',
      'settings.clampHint': 'Above the system line, every session truncates it to its own cap.',
      'settings.loading': 'Loading…',
      'settings.unavailable': 'Settings are unavailable right now. Reload the page to retry.',
      'settings.retry': 'Retry',
      'settings.saveFailed': 'Could not save: {message}',
      'settings.saved': 'Saved',
    }

    const zh = {
      'row.label': '上下文压缩',
      'row.off': '已关闭',
      'row.unavailable': '—',
      'panel.open': '调整压缩阈值',
      'panel.used': '已用',
      'panel.suggested': '建议线',
      'panel.system': '系统自动压缩线',
      'panel.follow': '跟随默认（{percent}%）',
      'panel.custom': '自定义',
      'panel.off': '关闭',
      'panel.offHint': '系统自动压缩线仍然有效。',
      'panel.cap': '最高 {percent}%',
      'panel.saving': '保存中…',
      'panel.saveFailed': '保存失败：{message}',
      'panel.windowTooSmall': '这个模型的窗口在系统线下方没有空间，因此不给建议。',
      'panel.unknownWindow': '第一次请求之后才知道窗口大小。',
      'panel.capped': '受系统线限制，最高 {percent}%。',
      'panel.unavailable': '暂时读不到设置，刷新页面重试。',
      'panel.retry': '重试',
      'settings.title': '默认压缩阈值',
      'settings.description': '新会话从这里开始；单个会话可以在模型菜单里覆盖。',
      'settings.clampHint': '超过系统线时，每个会话会按自己的上限截断。',
      'settings.loading': '加载中…',
      'settings.unavailable': '暂时读不到设置，刷新页面重试。',
      'settings.retry': '重试',
      'settings.saveFailed': '保存失败：{message}',
      'settings.saved': '已保存',
    }

    /** Interpolate `{name}` placeholders without a dependency. */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) => (
        values && Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    /** Read JSON from a same-origin route; throws on a non-2xx answer. */
    async function getJson(url) {
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`${response.status}`)
      return await response.json()
    }

    /** POST a JSON body to a same-origin route; throws on a non-2xx answer. */
    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${response.status}`)
      return await response.json()
    }

    const CAPTION = { color: 'var(--dsw-alias-label-caption, #8a8a8a)', fontSize: 11, lineHeight: 1.5 }
    const DIMMED = { color: 'var(--dsw-alias-label-dimmed, #9a9a9a)', fontSize: 11 }
    const STRONG = { color: 'var(--dsw-alias-label-primary, #1f1f1f)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }
    const ERROR = { color: 'var(--dsw-alias-state-error-primary, #c0392b)' }
    const ACCENT = 'var(--dsw-alias-state-business-primary, #4d6bfe)'

    /** Percentage of the window one token count represents. */
    function pct(tokens, windowSize) {
      if (!Number.isFinite(tokens) || !Number.isFinite(windowSize) || windowSize <= 0) return null
      return Math.max(0, Math.min(100, (tokens / windowSize) * 100))
    }

    /** Compact token count for the reading line. */
    function tokens(value) {
      if (!Number.isFinite(value)) return '?'
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
      if (value >= 1_000) return `${Math.round(value / 1_000)}k`
      return String(Math.round(value))
    }

    /** A three-marker bar: used, suggested line, and the system's own line. */
    function BudgetBar({ usedPercent, suggestedPercent, systemPercent, label }) {
      const marker = (left, color, text) => h('span', {
        title: text,
        style: { position: 'absolute', top: -2, bottom: -2, left: `${left}%`, width: 2, borderRadius: 1, background: color },
      })
      return h('div', {
        role: 'img',
        'aria-label': label,
        style: {
          position: 'relative',
          height: 6,
          margin: '18px 2px 6px',
          borderRadius: 3,
          background: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.08))',
        },
      }, [
        usedPercent === null ? null : h('span', {
          key: 'used',
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${usedPercent}%`,
            borderRadius: 3,
            background: ACCENT,
            opacity: 0.75,
          },
        }),
        suggestedPercent === null ? null : marker(suggestedPercent, 'var(--dsw-alias-label-primary, #1f1f1f)', `${Math.round(suggestedPercent)}%`),
        systemPercent === null ? null : marker(systemPercent, 'var(--dsw-alias-state-warn-label, #b26a00)', `${Math.round(systemPercent)}%`),
      ])
    }

    /** Range input; commits on release so one drag is one write. */
    function PercentSlider({ value, min, max, disabled, onCommit, label }) {
      const [draft, setDraft] = useState(value)
      useEffect(() => { setDraft(value) }, [value])
      const commit = () => { if (draft !== value) onCommit(draft) }
      return h('input', {
        type: 'range',
        min,
        max,
        step: 1,
        value: draft,
        disabled,
        'aria-label': label,
        onChange: (event) => { setDraft(Number(event.target.value)) },
        onPointerUp: commit,
        onPointerCancel: commit,
        onKeyUp: commit,
        onBlur: commit,
        style: { width: '100%', accentColor: ACCENT, cursor: disabled ? 'default' : 'pointer' },
      })
    }

    /** Small text button used by the retry paths. */
    function LinkButton({ onClick, children }) {
      return h('button', {
        type: 'button',
        onClick,
        style: {
          alignSelf: 'flex-start',
          padding: 0,
          border: 0,
          background: 'transparent',
          color: ACCENT,
          font: 'inherit',
          fontSize: 11,
          cursor: 'pointer',
          textDecoration: 'underline',
        },
      }, children)
    }

    /**
     * Session row inside the model menu.
     * @param props - slot runtime props (sessionId, locked, useProjection, t).
     */
    function SmartCompactRow(props) {
      const { sessionId, locked, useProjection, t } = props
      const pressure = useProjection('contextPressure')
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState(null)
      const [open, setOpen] = useState(false)
      const [saving, setSaving] = useState(false)
      const windowRef = useRef(undefined)
      const retried = useRef(undefined)

      const load = useCallback(() => {
        setFailure(null)
        const hint = windowRef.current === undefined ? '' : `&window=${Math.round(windowRef.current)}`
        return getJson(`${STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}${hint}`)
          .then((next) => { setState(next) })
          .catch(() => { setFailure(t('panel.unavailable')) })
      }, [sessionId, t])

      useEffect(() => { windowRef.current = pressure ? pressure.contextWindow : undefined })
      useEffect(() => { void load() }, [load])

      const session = state === null ? null : state.session
      const windowSize = windowRef.current
      const usedTokens = pressure ? pressure.pressureTokens : undefined
      const usedPercent = pct(usedTokens, windowSize)
      const suggestedPercent = session && session.percent !== null ? session.percent : null

      // The projection may report the window after the first fetch; ask again
      // once per window value so the system line and the cap stop being unknown.
      useEffect(() => {
        if (windowSize === undefined || session == null || session.percent !== null) return
        if (retried.current === windowSize) return
        retried.current = windowSize
        void load()
      }, [windowSize, session, load])

      const apply = useCallback((threshold) => {
        setSaving(true)
        setFailure(null)
        return postJson(SESSION_PATH, { sessionId, threshold })
          .then((next) => { setState((current) => (current === null ? current : { ...current, session: next })) })
          .catch((error) => { setFailure(fill(t('panel.saveFailed'), { message: error.message })) })
          .finally(() => { setSaving(false) })
      }, [sessionId, t])

      const defaultPercent = state === null ? 60 : state.defaultPercent
      const minPercent = state === null ? 30 : state.minPercent
      const maxPercent = session && session.maxPercent !== null ? session.maxPercent : 99
      const kind = session === null ? 'default' : session.threshold.kind
      const unknownWindow = session === null || session.status === 'unknown-window'
      const tooSmall = session !== null && session.status === 'window-too-small'
      const rowDisabled = locked || session === null || tooSmall

      const choose = (next) => {
        if (next === 'default') return void apply({ kind: 'default' })
        if (next === 'off') return void apply({ kind: 'off' })
        return void apply({ kind: 'percent', percent: suggestedPercent ?? defaultPercent })
      }

      const summary = kind === 'off'
        ? t('row.off')
        : suggestedPercent === null
          ? t('row.unavailable')
          : `${usedPercent === null ? '—' : Math.round(usedPercent)}% / ${suggestedPercent}%`

      const radio = (value, label, hint) => h('label', {
        key: `radio-${value}`,
        style: { display: 'flex', alignItems: 'flex-start', gap: 6, ...CAPTION, cursor: 'pointer' },
      }, [
        h('input', {
          key: 'input',
          type: 'radio',
          name: `smart-compact-${sessionId}`,
          checked: kind === value,
          disabled: saving,
          onChange: () => { choose(value) },
          style: { marginTop: 2, accentColor: ACCENT },
        }),
        h('span', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: 1 } }, [
          h('span', { key: 'label', style: kind === value ? STRONG : undefined }, label),
          hint === undefined ? null : h('span', { key: 'hint', style: DIMMED }, hint),
        ]),
      ])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 2px 6px' } }, [
        h('div', { key: 'row', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } }, [
          h('button', {
            key: 'toggle',
            type: 'button',
            'aria-expanded': open,
            'aria-label': t('panel.open'),
            disabled: rowDisabled,
            onClick: () => { setOpen((value) => !value); if (!open) void load() },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flex: 1,
              minWidth: 0,
              padding: '4px 0',
              border: 0,
              background: 'transparent',
              color: rowDisabled ? DIMMED.color : STRONG.color,
              cursor: rowDisabled ? 'default' : 'pointer',
              textAlign: 'left',
              font: 'inherit',
            },
          }, [
            h('span', { key: 'label', style: STRONG }, t('row.label')),
            h('span', { key: 'value', style: { ...CAPTION, marginLeft: 'auto' } }, summary),
            h('span', {
              key: 'chevron',
              style: { ...CAPTION, fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' },
            }, '›'),
          ]),
        ]),
        failure === null ? null : h('div', { key: 'failure', style: { ...CAPTION, ...ERROR } }, failure),
        failure === null ? null : h(LinkButton, { key: 'retry', onClick: () => { void load() } }, t('panel.retry')),
        open ? h('div', { key: 'panel', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 2px 4px' } }, [
          h(BudgetBar, {
            key: 'bar',
            usedPercent,
            suggestedPercent,
            systemPercent: session && session.railPercent !== null ? session.railPercent : null,
            label: t('panel.suggested'),
          }),
          h('div', { key: 'reading', style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, [
            h('span', { key: 'used', style: CAPTION },
              `${t('panel.used')} ${tokens(usedTokens)} / ${tokens(windowSize)}`),
            h('span', { key: 'suggested', style: CAPTION },
              suggestedPercent === null ? '' : `${t('panel.suggested')} ${suggestedPercent}%`),
          ]),
          tooSmall
            ? h('div', { key: 'too-small', style: CAPTION }, t('panel.windowTooSmall'))
            : h(React.Fragment, { key: 'controls' }, [
              radio('default', fill(t('panel.follow'), { percent: defaultPercent })),
              h('div', { key: 'custom', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                radio('custom', t('panel.custom'), kind === 'percent' && maxPercent < 99 ? fill(t('panel.cap'), { percent: maxPercent }) : undefined),
                kind === 'percent'
                  ? h(PercentSlider, {
                    key: 'slider',
                    value: suggestedPercent ?? defaultPercent,
                    min: minPercent,
                    max: maxPercent,
                    disabled: saving || unknownWindow,
                    label: t('panel.suggested'),
                    onCommit: (percent) => { void apply({ kind: 'percent', percent }) },
                  })
                  : null,
              ]),
              radio('off', t('panel.off'), t('panel.offHint')),
            ]),
          session !== null && session.railPercent !== null
            ? h('div', { key: 'system', style: DIMMED }, `${t('panel.system')} ${Math.round(session.railPercent)}%`)
            : null,
          session !== null && session.clamped
            ? h('div', { key: 'capped', style: DIMMED }, fill(t('panel.capped'), { percent: session.percent }))
            : null,
          unknownWindow ? h('div', { key: 'unknown', style: CAPTION }, t('panel.unknownWindow')) : null,
          saving ? h('div', { key: 'saving', style: CAPTION }, t('panel.saving')) : null,
        ]) : null,
      ])
    }

    /**
     * Plugin page: the global default threshold.
     * @param props - owner props (`view: 'page'`) plus the locale table.
     */
    function SmartCompactSettings(props) {
      const { t } = props
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState(null)
      const [saved, setSaved] = useState(false)
      const [loading, setLoading] = useState(true)
      const timer = useRef(undefined)

      const load = useCallback(() => {
        setLoading(true)
        return getJson(STATE_PATH)
          .then((next) => { setState(next); setFailure(null) })
          .catch(() => { setFailure(t('settings.unavailable')) })
          .finally(() => { setLoading(false) })
      }, [t])

      useEffect(() => { void load(); return () => { if (timer.current !== undefined) clearTimeout(timer.current) } }, [load])

      const commit = (percent) => {
        setFailure(null)
        postJson(DEFAULT_PATH, { defaultPercent: percent })
          .then((next) => {
            setState((current) => (current === null ? current : { ...current, defaultPercent: next.defaultPercent }))
            setSaved(true)
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => { setSaved(false) }, 1600)
          })
          .catch((error) => { setFailure(fill(t('settings.saveFailed'), { message: error.message })) })
      }

      if (loading && state === null) return h('div', { style: CAPTION }, t('settings.loading'))
      if (state === null) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('div', { key: 'title', style: STRONG }, t('settings.title')),
          h('div', { key: 'failure', style: { ...CAPTION, ...ERROR } }, failure ?? ''),
          h(LinkButton, { key: 'retry', onClick: () => { void load() } }, t('settings.retry')),
        ])
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460 } }, [
        h('div', { key: 'title', style: STRONG }, t('settings.title')),
        h('div', { key: 'description', style: CAPTION }, t('settings.description')),
        h('div', { key: 'value', style: { ...STRONG, fontSize: 20 } }, `${state.defaultPercent}%`),
        h(PercentSlider, {
          key: 'slider',
          value: state.defaultPercent,
          min: state.minPercent,
          max: 90,
          disabled: false,
          label: t('settings.title'),
          onCommit: commit,
        }),
        h('div', { key: 'clamp', style: DIMMED }, t('settings.clampHint')),
        saved ? h('div', { key: 'saved', style: CAPTION }, t('settings.saved')) : null,
        failure === null ? null : h('div', { key: 'failure', style: { ...CAPTION, ...ERROR } }, failure),
      ])
    }

    /**
     * Client half entry point.
     * @param ctx - Cordis client context with `slots` and `locale`.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }))

      ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
        name: 'conversation.input.model.options',
        id: 'smart-compact',
        order: 40,
        label: () => ctx.locale.resolveText({ en: 'Context compaction', zh: '上下文压缩' }),
        locale: NS,
      }, SmartCompactRow))

      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: '@local/dsh-smart-compact',
        locale: NS,
      }, SmartCompactSettings))
    }

    exports.name = 'smart-compact'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
