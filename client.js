/**
 * @local/dsh-smart-compact — Client half.
 *
 * Two seats:
 *
 * - `conversation.input.model.options` — one row in the model/reasoning menu
 *   showing the current context use against this session's suggested threshold;
 *   expanding it reveals a slider that commits on release.
 * - `plugins.bundle.config` — the plugin page's default-threshold control.
 *
 * No build step: DSH loads this file as a Cordis client bundle through the
 * `dsh.client` declaration in package.json, and packs it with the package.
 *
 * Writes go through the Host's `/smart-compact/*` routes. Reads for the live
 * usage number ride the `contextPressure` projection supplied by the slot props
 * (`useProjection`), so the row updates without polling.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-smart-compact',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const NS = 'smart-compact'
    const STATE_PATH = '/smart-compact/state'
    const SESSION_PATH = '/smart-compact/session'
    const DEFAULT_PATH = '/smart-compact/default'

    const en = {
      'row.label': 'Context compaction',
      'row.menuLabel': 'Compaction threshold',
      'row.unavailable': 'Context window not reported yet',
      'row.off': 'off',
      'row.pending': 'queued',
      'panel.open': 'Change the compaction threshold',
      'panel.used': 'Used',
      'panel.suggested': 'Agent compacts at',
      'panel.rail': 'Harness auto-compacts at',
      'panel.followDefault': 'Follow the plugin default',
      'panel.defaultValue': 'default {percent}%',
      'panel.off': 'Turn compaction off for this session',
      'panel.offHint': 'The Harness still compacts at its own line.',
      'panel.saving': 'Saving…',
      'panel.saveFailed': 'Could not save: {message}',
      'panel.windowTooSmall': 'This model leaves no room below the Harness line, so no suggestion is made.',
      'panel.unknownWindow': 'The context window is known after the first request.',
      'panel.capped': 'The Harness line caps this at {percent}%.',
      'panel.percentShort': '{percent}%',
      'panel.tokensOf': 'of {tokens}',
      'settings.title': 'Default compaction threshold',
      'settings.description': 'New sessions start here. A session can override it from the model menu.',
      'settings.loading': 'Loading…',
      'settings.unavailable': 'The plugin host routes are unavailable; is the plugin enabled in a Web session?',
      'settings.saveFailed': 'Could not save: {message}',
      'settings.saved': 'Saved',
      'settings.offNote': 'A per-session override still applies; the Harness line is never moved.',
    }

    const zh = {
      'row.label': '上下文压缩',
      'row.menuLabel': '压缩阈值',
      'row.unavailable': '还没有拿到窗口大小',
      'row.off': '已关闭',
      'row.pending': '已排队',
      'panel.open': '调整压缩阈值',
      'panel.used': '已用',
      'panel.suggested': 'agent 在此压缩',
      'panel.rail': 'Harness 自动压缩线',
      'panel.followDefault': '跟随插件默认值',
      'panel.defaultValue': '默认 {percent}%',
      'panel.off': '本会话关闭压缩',
      'panel.offHint': 'Harness 自己的自动压缩线仍然有效。',
      'panel.saving': '保存中…',
      'panel.saveFailed': '保存失败：{message}',
      'panel.windowTooSmall': '这个模型在 Harness 线下方没有空间，因此不给建议。',
      'panel.unknownWindow': '第一次请求之后才知道窗口大小。',
      'panel.capped': '受 Harness 压缩线限制，最高 {percent}%。',
      'panel.percentShort': '{percent}%',
      'panel.tokensOf': '/ {tokens}',
      'settings.title': '默认压缩阈值',
      'settings.description': '新会话从这里开始；单个会话可以在模型菜单里覆盖它。',
      'settings.loading': '加载中…',
      'settings.unavailable': '插件宿主路由不可用：插件是否在 Web 会话里启用？',
      'settings.saveFailed': '保存失败：{message}',
      'settings.saved': '已保存',
      'settings.offNote': '单个会话的覆盖仍然生效；Harness 的压缩线不会被移动。',
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

    const SEC = {
      label: { color: 'var(--dsw-alias-label-secondary, #666)', fontSize: 12 },
      caption: { color: 'var(--dsw-alias-label-caption, #8a8a8a)', fontSize: 11, lineHeight: 1.5 },
      dimmed: { color: 'var(--dsw-alias-label-dimmed, #9a9a9a)', fontSize: 11 },
      number: { color: 'var(--dsw-alias-label-primary, #1f1f1f)', fontVariantNumeric: 'tabular-nums' },
    }

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

    /** A three-marker bar: used, suggested, and the Harness' own line. */
    function BudgetBar({ usedPercent, suggestedPercent, railPercent, t }) {
      const marker = (left, color, label) => h('span', {
        title: label,
        style: {
          position: 'absolute',
          top: -2,
          bottom: -2,
          left: `${left}%`,
          width: 2,
          borderRadius: 1,
          background: color,
        },
      })
      return h('div', {
        role: 'img',
        'aria-label': fill(t('panel.used'), {}) + ' ' + (usedPercent === null ? '?' : Math.round(usedPercent) + '%'),
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
            background: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            opacity: 0.75,
          },
        }),
        suggestedPercent === null ? null : marker(suggestedPercent, 'var(--dsw-alias-label-primary, #1f1f1f)', t('panel.suggested')),
        railPercent === null ? null : marker(railPercent, 'var(--dsw-alias-state-warn-label, #b26a00)', t('panel.rail')),
      ])
    }

    /** Range input; commits on release so one drag is one write. */
    function PercentSlider({ value, min, max, disabled, onCommit, label }) {
      const [draft, setDraft] = useState(value)
      useEffect(() => { setDraft(value) }, [value])
      const commit = () => {
        if (draft !== value) onCommit(draft)
      }
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
        style: { width: '100%', accentColor: 'var(--dsw-alias-state-business-primary, #4d6bfe)', cursor: disabled ? 'default' : 'pointer' },
      })
    }

    /** One threshold-reading line, shared by the row and the panel. */
    function summaryText(session, t) {
      if (session === null || session === undefined) return t('row.unavailable')
      if (session.status === 'off') return t('row.off')
      if (session.percent === null) return t('row.unavailable')
      return `${session.percent}%`
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
          .catch(() => { setFailure(t('settings.unavailable')) })
      }, [sessionId, t])

      useEffect(() => { windowRef.current = pressure ? pressure.contextWindow : undefined })

      useEffect(() => { void load() }, [load])

      const session = state === null ? null : state.session
      const windowSize = windowRef.current
      const usedTokens = pressure ? pressure.pressureTokens : undefined
      const usedPercent = pct(usedTokens, windowSize)
      const suggestedPercent = session && session.percent !== null ? session.percent : null

      // The projection may report the window after the first fetch; ask again
      // once per window value so the rail and the cap stop being unknown.
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
      const followsDefault = session !== null && session.threshold.kind === 'default'
      const off = session !== null && session.threshold.kind === 'off'
      const unknownWindow = session === null || session.status === 'unknown-window'
      const tooSmall = session !== null && session.status === 'window-too-small'

      const rowDisabled = locked || session === null || tooSmall

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 2px 6px' } }, [
        h('div', {
          key: 'row',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
        }, [
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
              color: rowDisabled ? SEC.dimmed.color : SEC.number.color,
              cursor: rowDisabled ? 'default' : 'pointer',
              textAlign: 'left',
              font: 'inherit',
            },
          }, [
            h('span', { key: 'label', style: SEC.number }, t('row.label')),
            h('span', { key: 'value', style: { ...SEC.caption, marginLeft: 'auto' } },
              off ? t('row.off') : summaryText(session, t)),
            h('span', { key: 'chevron', style: { ...SEC.caption, fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' } }, '›'),
          ]),
        ]),
        failure === null ? null : h('div', { key: 'failure', style: { ...SEC.caption, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } }, failure),
        open ? h('div', { key: 'panel', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 2px 4px' } }, [
          h(BudgetBar, {
            key: 'bar',
            usedPercent,
            suggestedPercent,
            railPercent: session && session.railPercent !== null ? session.railPercent : null,
            t,
          }),
          h('div', { key: 'reading', style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, [
            h('span', { key: 'used', style: SEC.caption },
              `${t('panel.used')} ${tokens(usedTokens)} ${fill(t('panel.tokensOf'), { tokens: tokens(windowSize) })}`),
            h('span', { key: 'suggested', style: SEC.caption },
              suggestedPercent === null ? '' : `${t('panel.suggested')} ${suggestedPercent}%`),
          ]),
          tooSmall
            ? h('div', { key: 'too-small', style: SEC.caption }, t('panel.windowTooSmall'))
            : h(React.Fragment, { key: 'controls' }, [
              h(PercentSlider, {
                key: 'slider',
                value: suggestedPercent === null ? defaultPercent : suggestedPercent,
                min: minPercent,
                max: maxPercent,
                disabled: saving || unknownWindow || off,
                label: t('panel.suggested'),
                onCommit: (percent) => { void apply({ kind: 'percent', percent }) },
              }),
              h('label', { key: 'follow', style: { display: 'flex', alignItems: 'center', gap: 6, ...SEC.caption, cursor: 'pointer' } }, [
                h('input', {
                  key: 'box',
                  type: 'checkbox',
                  checked: followsDefault,
                  disabled: saving,
                  onChange: () => { void apply({ kind: 'default' }) },
                }),
                h('span', { key: 'text' }, `${t('panel.followDefault')} · ${fill(t('panel.defaultValue'), { percent: defaultPercent })}`),
              ]),
              h('label', { key: 'off', style: { display: 'flex', alignItems: 'center', gap: 6, ...SEC.caption, cursor: 'pointer' } }, [
                h('input', {
                  key: 'box',
                  type: 'checkbox',
                  checked: off,
                  disabled: saving,
                  onChange: (event) => { void apply(event.target.checked ? { kind: 'off' } : { kind: 'default' }) },
                }),
                h('span', { key: 'text' }, t('panel.off')),
              ]),
            ]),
          tooSmall || session === null ? null : h('div', { key: 'rail', style: SEC.dimmed },
            `${t('panel.rail')} ${Math.round(session.railPercent)}%`),
          session !== null && session.clamped
            ? h('div', { key: 'capped', style: SEC.dimmed }, fill(t('panel.capped'), { percent: session.percent }))
            : null,
          unknownWindow ? h('div', { key: 'unknown', style: SEC.caption }, t('panel.unknownWindow')) : null,
          saving ? h('div', { key: 'saving', style: SEC.caption }, t('panel.saving')) : null,
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

      if (loading && state === null) return h('div', { style: SEC.caption }, t('settings.loading'))
      if (state === null) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('div', { key: 'title', style: SEC.number }, t('settings.title')),
          h('div', { key: 'failure', style: { ...SEC.caption, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } }, failure ?? ''),
        ])
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 460 } }, [
        h('div', { key: 'title', style: SEC.number }, t('settings.title')),
        h('div', { key: 'description', style: SEC.caption }, t('settings.description')),
        h('div', { key: 'value', style: { ...SEC.number, fontSize: 20, fontVariantNumeric: 'tabular-nums' } }, `${state.defaultPercent}%`),
        h(PercentSlider, {
          key: 'slider',
          value: state.defaultPercent,
          min: state.minPercent,
          max: 90,
          disabled: false,
          label: t('settings.title'),
          onCommit: commit,
        }),
        h('div', { key: 'note', style: SEC.dimmed }, t('settings.offNote')),
        saved ? h('div', { key: 'saved', style: SEC.caption }, t('settings.saved')) : null,
        failure === null ? null : h('div', { key: 'failure', style: { ...SEC.caption, color: 'var(--dsw-alias-state-error-primary, #c0392b)' } }, failure),
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
