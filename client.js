/**
 * @local/dsh-smart-compact — Client half.
 *
 * Two seats:
 *
 * - `conversation.input.model.options` — one row in the model/reasoning menu
 *   that matches the menu's own 34px cells, expanding into a threshold control
 *   whose track is the context bar itself.
 * - `plugins.bundle.config` — the plugin page's default-threshold control.
 *
 * No build step: DSH loads this file as a Cordis client bundle through the
 * `dsh.client` declaration in package.json. Styles are injected once as a
 * <style> element so the row can reuse the menu cell metrics exactly.
 */

window.__ModuleLoader__.load({
  id: 'dsh-smart-compact',
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
    const FORCE_PATH = '/smart-compact/force'
    const STYLE_ID = 'dsh-smart-compact-style'

    const en = {
      'row.label': 'Context compaction',
      'row.off': 'off',
      'row.none': '—',
      'panel.used': 'Used',
      'panel.suggested': 'Suggested line',
      'panel.system': 'System line',
      'panel.follow': 'Follow the default ({percent}%)',
      'panel.custom': 'Custom',
      'panel.off': 'Off',
      'panel.offHint': 'The system line still applies.',
      'panel.cap': 'max {percent}%',
      'panel.saving': 'Saving…',
      'panel.saveFailed': 'Could not save: {message}',
      'panel.windowTooSmall': 'This model leaves no room below the system line, so no suggestion is made.',
      'panel.unknownWindow': 'The window is known after the first request.',
      'panel.capped': 'The system line caps this at {percent}%.',
      'panel.unavailable': 'Settings are unavailable right now. Reload to retry.',
      'panel.retry': 'Retry',
      'settings.title': 'Default compaction threshold',
      'settings.description': 'New sessions start here; a session can override it from the model menu.',
      'settings.clampHint': 'Above the system line, every session truncates it to its own cap.',
      'settings.loading': 'Loading…',
      'settings.unavailable': 'Settings are unavailable right now. Reload to retry.',
      'settings.retry': 'Retry',
      'settings.saveFailed': 'Could not save: {message}',
      'settings.saved': 'Saved',
      'settings.bypass': 'Allow the bypass (testing)',
      'settings.bypassHint': 'Adds /smart-compact force and a smart_compact_force tool. Both skip the suggested line — never an off session. Turn it off when testing ends.',
      'panel.bypass': 'Bypass on: /smart-compact force',
    }

    const zh = {
      'row.label': '上下文压缩',
      'row.off': '已关闭',
      'row.none': '—',
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
      'settings.bypass': '允许绕过阈值（测试用）',
      'settings.bypassHint': '开启后才有 /smart-compact force 和 smart_compact_force 工具，两者都无视建议线，但已关闭的会话依然不压。测试完请关掉。',
      'panel.bypass': '绕过已开启：/smart-compact force',
    }

    /**
     * Menu-cell metrics copied from the host menu (ModelSelect.module.css):
     * 34px rows, 13/20 type, 8px padding, tertiary value, 12px chevron.
     */
    const CSS = `
.dsc-wrap { display: flex; flex-direction: column; width: 100%; }
.dsc-cell {
  box-sizing: border-box; display: flex; align-items: center; gap: 6px;
  width: auto; min-width: 100%; height: 34px; padding: 0 8px;
  border: none; border-radius: var(--dsw-radius-md, 8px);
  background: transparent; color: var(--dsw-alias-label-primary, #1f1f1f);
  font-family: inherit; font-size: 13px; line-height: 20px; text-align: left; outline: none;
  cursor: pointer;
}
@media (hover: hover) { .dsc-cell:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); } }
.dsc-cell:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }
.dsc-cell:disabled { color: var(--dsw-alias-label-dimmed, #9a9a9a); cursor: default; }
.dsc-cellLabel { flex: 0 0 auto; white-space: nowrap; }
.dsc-cellValue {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; text-align: right; color: var(--dsw-alias-label-tertiary, #8a8a8a);
  font-variant-numeric: tabular-nums;
}
.dsc-chevron { flex: 0 0 auto; width: 12px; height: 12px; color: var(--dsw-alias-menu-icon, #8a8a8a); transition: transform 120ms ease; }
.dsc-chevronOpen { transform: rotate(90deg); }
.dsc-panel { display: flex; flex-direction: column; gap: 8px; padding: 4px 8px 10px; }
.dsc-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dsc-caption { color: var(--dsw-alias-label-caption, #8a8a8a); font-size: 11px; line-height: 16px; }
.dsc-num { color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; font-variant-numeric: tabular-nums; }
.dsc-strong { color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 13px; }
.dsc-error { color: var(--dsw-alias-state-error-primary, #c0392b); }
.dsc-track { position: relative; display: flex; align-items: center; height: 24px; margin: 2px 0 0; }
.dsc-bar {
  position: relative; width: 100%; height: 6px; border-radius: 3px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.1));
}
.dsc-barUsed { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--dsw-alias-state-business-primary, #4d6bfe); opacity: .55; }
.dsc-barTick { position: absolute; top: -4px; bottom: -4px; width: 1px; background: var(--dsw-alias-state-warn-label, #b26a00); opacity: .8; }
.dsc-barKnob {
  position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
  background: var(--dsw-alias-label-primary, #1f1f1f); box-shadow: 0 0 0 2px var(--dsw-menu-surface-fill, #fff);
  pointer-events: none;
}
.dsc-range { position: absolute; inset: 0; width: 100%; margin: 0; opacity: 0; cursor: pointer; }
.dsc-range:disabled { cursor: default; }
.dsc-track:focus-within .dsc-barKnob { box-shadow: 0 0 0 2px var(--dsw-menu-surface-fill, #fff), 0 0 0 4px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe)); }
.dsc-radio {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 0;
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #666);
  font-family: inherit; font-size: 12px; line-height: 20px; text-align: left; cursor: pointer;
}
.dsc-radio:disabled { cursor: default; color: var(--dsw-alias-label-dimmed, #9a9a9a); }
.dsc-dot {
  flex: 0 0 auto; box-sizing: border-box; width: 12px; height: 12px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-label-tertiary, #8a8a8a);
}
.dsc-radioOn .dsc-dot { border-color: var(--dsw-alias-state-business-primary, #4d6bfe); background: var(--dsw-alias-state-business-primary, #4d6bfe); }
.dsc-radioOn .dsc-dot::after {
  content: ''; display: block; width: 4px; height: 4px; margin: 3px; border-radius: 50%;
  background: var(--dsw-menu-surface-fill, #fff);
}
.dsc-link { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-state-business-primary, #4d6bfe); font-family: inherit; font-size: 11px; cursor: pointer; text-decoration: underline; align-self: flex-start; }
.dsc-page { display: flex; flex-direction: column; gap: 8px; max-width: 460px; }
.dsc-pageValue { color: var(--dsw-alias-label-primary, #1f1f1f); font-size: 20px; font-variant-numeric: tabular-nums; }
.dsc-check {
  display: flex; align-items: center; gap: 8px; margin-top: 4px;
  color: var(--dsw-alias-label-primary, #1f1f1f); font-family: inherit; font-size: 13px; line-height: 20px;
  cursor: pointer;
}
.dsc-check input { margin: 0; accent-color: var(--dsw-alias-state-business-primary, #4d6bfe); }
`

    /** Inject the stylesheet once per page. */
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
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

    /** Percentage of the window one token count represents. */
    function pct(tokens, windowSize) {
      if (!Number.isFinite(tokens) || !Number.isFinite(windowSize) || windowSize <= 0) return null
      return Math.max(0, Math.min(100, (tokens / windowSize) * 100))
    }

    /** Compact token count for a reading line. */
    function tokens(value) {
      if (!Number.isFinite(value)) return '?'
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
      if (value >= 1_000) return `${Math.round(value / 1_000)}k`
      return String(Math.round(value))
    }

    /** The menu's own 12px chevron, drawn inline so no icon module is required. */
    function Chevron({ open }) {
      return h('svg', {
        className: open ? 'dsc-chevron dsc-chevronOpen' : 'dsc-chevron',
        viewBox: '0 0 12 12',
        'aria-hidden': 'true',
      }, h('path', {
        d: 'M4.5 2.5 L8 6 L4.5 9.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    /**
     * One draggable track: the context bar is the slider, so the used fill and
     * the threshold knob live on the same pixels the pointer drags.
     */
    function ThresholdTrack({ usedPercent, value, base, min, max, systemPercent, disabled, onDraft, onCommit, label }) {
      const [draft, setDraft] = useState(value)
      useEffect(() => { setDraft(value) }, [value])
      // Compare against the committed value, not `value`: the parent mirrors the
      // draft into it while dragging, so a comparison with `value` would always
      // be equal and the release would never save.
      const commit = () => { if (draft !== base) onCommit(draft) }
      return h('div', { className: 'dsc-track' }, [
        h('div', { key: 'bar', className: 'dsc-bar' }, [
          usedPercent === null ? null : h('span', {
            key: 'used',
            className: 'dsc-barUsed',
            style: { width: `${usedPercent}%` },
            title: `${Math.round(usedPercent)}%`,
          }),
          systemPercent === null ? null : h('span', {
            key: 'system',
            className: 'dsc-barTick',
            style: { left: `${systemPercent}%` },
            title: `${Math.round(systemPercent)}%`,
          }),
          h('span', { key: 'knob', className: 'dsc-barKnob', style: { left: `${draft}%` } }),
        ]),
        h('input', {
          key: 'range',
          className: 'dsc-range',
          type: 'range',
          min,
          max,
          step: 1,
          value: draft,
          disabled,
          'aria-label': label,
          'aria-valuetext': `${draft}%`,
          onChange: (event) => {
            const next = Number(event.target.value)
            setDraft(next)
            onDraft(next)
          },
          onPointerUp: commit,
          onPointerCancel: commit,
          onKeyUp: commit,
          onBlur: commit,
        }),
      ])
    }

    /** Small text button used by the retry paths. */
    function LinkButton({ onClick, children }) {
      return h('button', { type: 'button', className: 'dsc-link', onClick }, children)
    }

    /**
     * Session row inside the model menu.
     * @param props - slot runtime props (sessionId, locked, useProjection, t).
     */
    function SmartCompactRow(props) {
      const { sessionId, locked, useProjection, t } = props
      ensureStyles()
      const pressure = useProjection('contextPressure')
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState(null)
      const [open, setOpen] = useState(false)
      const [saving, setSaving] = useState(false)
      const [pendingKind, setPendingKind] = useState(null)
      const [draft, setDraft] = useState(null)
      const windowRef = useRef(undefined)
      const retried = useRef(undefined)

      const load = useCallback(() => {
        setFailure(null)
        const hint = windowRef.current === undefined ? '' : `&window=${Math.round(windowRef.current)}`
        return getJson(`${STATE_PATH}?sessionId=${encodeURIComponent(sessionId)}${hint}`)
          .then((next) => { setState(next); setDraft(null) })
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
          .finally(() => {
            setSaving(false)
            // The server value is authoritative again: a failed save reverts the
            // knob to it, and a successful one already carries the new value.
            setDraft(null)
          })
      }, [sessionId, t])

      const defaultPercent = state === null ? 60 : state.defaultPercent
      const minPercent = state === null ? 30 : state.minPercent
      const maxPercent = session && session.maxPercent !== null ? session.maxPercent : 99
      const kind = pendingKind ?? (session === null ? 'default' : session.threshold.kind)
      const unknownWindow = session === null || session.status === 'unknown-window'
      const tooSmall = session !== null && session.status === 'window-too-small'
      const rowDisabled = locked || session === null || tooSmall
      const shown = draft ?? suggestedPercent ?? defaultPercent

      /**
       * Keep the menu open: the host closes it when focus leaves the card, and
       * a mousedown on plain text would blur the trigger. Inputs keep their
       * default so the range still drags.
       */
      const keepFocus = (event) => {
        const target = event.target
        if (target instanceof Element && target.closest('input') !== null) return
        event.preventDefault()
      }

      const choose = (next) => {
        if (saving) return
        setDraft(null)
        setPendingKind(next)
        const threshold = next === 'default'
          ? { kind: 'default' }
          : next === 'off'
            ? { kind: 'off' }
            : { kind: 'percent', percent: suggestedPercent ?? defaultPercent }
        void apply(threshold).finally(() => { setPendingKind(null) })
      }

      const summary = saving
        ? t('panel.saving')
        : kind === 'off'
          ? t('row.off')
          : suggestedPercent === null
            ? t('row.none')
            : `${usedPercent === null ? '—' : Math.round(usedPercent)}% / ${suggestedPercent}%`

      const radio = (value, label, hint) => h('button', {
        key: `radio-${value}`,
        type: 'button',
        role: 'radio',
        'aria-checked': kind === value,
        className: kind === value ? 'dsc-radio dsc-radioOn' : 'dsc-radio',
        onClick: () => { choose(value) },
      }, [
        h('span', { key: 'dot', className: 'dsc-dot' }),
        h('span', { key: 'text' }, hint === undefined ? label : `${label} · ${hint}`),
      ])

      return h('div', { className: 'dsc-wrap', onMouseDown: keepFocus }, [
        h('button', {
          key: 'row',
          type: 'button',
          className: 'dsc-cell',
          disabled: rowDisabled,
          'aria-expanded': open,
          onClick: () => { setOpen((value) => !value); if (!open) void load() },
        }, [
          h('span', { key: 'label', className: 'dsc-cellLabel' }, t('row.label')),
          h('span', { key: 'value', className: 'dsc-cellValue' }, summary),
          h(Chevron, { key: 'chevron', open }),
        ]),
        open ? h('div', { key: 'panel', className: 'dsc-panel' }, [
          h('div', { key: 'reading', className: 'dsc-line' }, [
            h('span', { key: 'used', className: 'dsc-caption' },
              `${t('panel.used')} ${tokens(usedTokens)} / ${tokens(windowSize)}`),
            h('span', { key: 'value', className: 'dsc-num' },
              `${shown}%`),
          ]),
          tooSmall
            ? h('div', { key: 'too-small', className: 'dsc-caption' }, t('panel.windowTooSmall'))
            : h(ThresholdTrack, {
              key: 'track',
              usedPercent,
              value: shown,
              base: suggestedPercent ?? defaultPercent,
              min: minPercent,
              max: maxPercent,
              systemPercent: session && session.railPercent !== null ? session.railPercent : null,
              // Never disable while saving: the focused range input would blur
              // to <body>, which the host menu reads as "focus left the card"
              // and closes. Save-in-flight duplicates are ignored instead.
              disabled: unknownWindow || kind === 'off',
              label: t('panel.suggested'),
              onDraft: (next) => { setDraft(next) },
              onCommit: (next) => { if (!saving) void apply({ kind: 'percent', percent: next }) },
            }),
          tooSmall ? null : h('div', { key: 'radios', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
            radio('default', fill(t('panel.follow'), { percent: defaultPercent })),
            radio('percent', t('panel.custom'), kind === 'percent' && maxPercent < 99 ? fill(t('panel.cap'), { percent: maxPercent }) : undefined),
            radio('off', t('panel.off'), t('panel.offHint')),
          ]),
          session !== null && session.clamped
            ? h('div', { key: 'capped', className: 'dsc-caption' }, fill(t('panel.capped'), { percent: session.percent }))
            : null,
          unknownWindow ? h('div', { key: 'unknown', className: 'dsc-caption' }, t('panel.unknownWindow')) : null,
          state !== null && state.allowForce === true
            ? h('div', { key: 'bypass', className: 'dsc-caption' }, t('panel.bypass'))
            : null,
          failure === null ? null : h('div', { key: 'failure', className: 'dsc-caption dsc-error' }, failure),
          failure === null ? null : h(LinkButton, { key: 'retry', onClick: () => { void load() } }, t('panel.retry')),
        ]) : null,
      ])
    }

    /**
     * Plugin page: the global default threshold.
     * @param props - owner props (`view: 'page'`) plus the locale table.
     */
    function SmartCompactSettings(props) {
      const { t } = props
      ensureStyles()
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState(null)
      const [saved, setSaved] = useState(false)
      const [bypassSaving, setBypassSaving] = useState(false)
      const [loading, setLoading] = useState(true)
      const [draft, setDraft] = useState(null)
      const timer = useRef(undefined)

      const load = useCallback(() => {
        setLoading(true)
        return getJson(STATE_PATH)
          .then((next) => { setState(next); setFailure(null); setDraft(null) })
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
          .finally(() => { setDraft(null) })
      }

      /** The bypass is a global switch: turning it on or off changes what the
       *  model and the user can reach, so it saves immediately. */
      const toggleBypass = (next) => {
        setFailure(null)
        setBypassSaving(true)
        postJson(FORCE_PATH, { allowForce: next })
          .then(() => {
            setState((current) => (current === null ? current : { ...current, allowForce: next }))
            setSaved(true)
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => { setSaved(false) }, 1600)
          })
          .catch((error) => { setFailure(fill(t('settings.saveFailed'), { message: error.message })) })
          .finally(() => { setBypassSaving(false) })
      }

      if (loading && state === null) return h('div', { className: 'dsc-caption' }, t('settings.loading'))
      if (state === null) {
        return h('div', { className: 'dsc-page' }, [
          h('div', { key: 'title', className: 'dsc-strong' }, t('settings.title')),
          h('div', { key: 'failure', className: 'dsc-caption dsc-error' }, failure ?? ''),
          h(LinkButton, { key: 'retry', onClick: () => { void load() } }, t('settings.retry')),
        ])
      }

      return h('div', { className: 'dsc-page' }, [
        h('div', { key: 'title', className: 'dsc-strong' }, t('settings.title')),
        h('div', { key: 'description', className: 'dsc-caption' }, t('settings.description')),
        h('div', { key: 'value', className: 'dsc-pageValue' }, `${draft ?? state.defaultPercent}%`),
        h(ThresholdTrack, {
          key: 'track',
          usedPercent: null,
          value: draft ?? state.defaultPercent,
          base: state.defaultPercent,
          min: state.minPercent,
          max: 90,
          systemPercent: null,
          disabled: false,
          label: t('settings.title'),
          onDraft: (next) => { setDraft(next) },
          onCommit: commit,
        }),
        h('div', { key: 'clamp', className: 'dsc-caption' }, t('settings.clampHint')),
        h('label', { key: 'bypass', className: 'dsc-check' }, [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: state.allowForce === true,
            disabled: bypassSaving,
            onChange: (event) => { toggleBypass(event.target.checked) },
          }),
          h('span', { key: 'text' }, t('settings.bypass')),
        ]),
        h('div', { key: 'bypassHint', className: 'dsc-caption' }, t('settings.bypassHint')),
        saved ? h('div', { key: 'saved', className: 'dsc-caption' }, t('settings.saved')) : null,
        failure === null ? null : h('div', { key: 'failure', className: 'dsc-caption dsc-error' }, failure),
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
        key: 'dsh-smart-compact',
        locale: NS,
      }, SmartCompactSettings))
    }

    exports.name = 'smart-compact'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
