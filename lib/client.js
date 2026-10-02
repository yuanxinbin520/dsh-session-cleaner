/**
 * dsh-session-cleaner — Client half.
 *
 * Hand-written Module Loader bundle (no build step): the file in package.json's
 * "./client" export is exactly what DSH loads.
 *
 *   sidebar.workspaces.session.menu.item  -> "移动到其他工作区…" / "彻底删除会话…"
 *   shell.overlay                         -> the frame-level confirmation dialog
 *
 * Order 500/600 places both rows after the shipped Pin(100)/Rename(200)/
 * Fork(300)/Archive(400), and `separatorBefore` opens a plugin group below them.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cleaner',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useSyncExternalStore } = React
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const MenuItemButton = primitives.MenuItemButton
    const h = React.createElement

    const API = '/session-cleaner/api'

    // ------------------------------------------------------------ request store
    // The dialog lives in a frame-level `shell.overlay` entry, so it outlives
    // the menu row that opened it (the row unmounts as the menu closes).
    let current = null
    let token = 0
    const listeners = new Set()
    const subscribe = listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
    const getSnapshot = () => current
    const openDialog = request => {
      token += 1
      current = { ...request, token }
      for (const listener of [...listeners]) { try { listener() } catch { /* ignore */ } }
    }
    const closeDialog = () => {
      current = null
      for (const listener of [...listeners]) { try { listener() } catch { /* ignore */ } }
    }

    // ------------------------------------------------------------ host calls
    let clientCtx = null
    const request = async (path, options) => {
      const response = await fetch(API + path, options)
      let payload
      try { payload = await response.json() }
      catch { throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）`) }
      if (!payload || payload.ok !== true) {
        const error = new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
        error.code = payload?.code
        throw error
      }
      return payload.result
    }
    const callApi = (path, body) => request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {})
    })
    const refreshLists = () => {
      try { clientCtx?.sessions?.refresh?.() } catch { /* ignore */ }
      try { clientCtx?.workspaces?.refresh?.() } catch { /* ignore */ }
    }

    // ------------------------------------------------------------ menu rows
    const useDismiss = useMenuOpenState => {
      const hook = typeof useMenuOpenState === 'function' ? useMenuOpenState : null
      if (hook === null) return () => {}
      const [, setMenuOpen] = hook()
      return () => { try { setMenuOpen(false) } catch { /* ignore */ } }
    }

    const MoveRow = ({ sessionId, displayTitle, useMenuOpenState }) => {
      const dismiss = useDismiss(useMenuOpenState)
      return h(MenuItemButton, {
        separatorBefore: true,
        onSelect: () => { dismiss(); openDialog({ kind: 'move', sessionId, displayTitle }) }
      }, '移动到其他工作区…')
    }

    const DeleteRow = ({ sessionId, displayTitle, useMenuOpenState }) => {
      const dismiss = useDismiss(useMenuOpenState)
      return h(MenuItemButton, {
        onSelect: () => { dismiss(); openDialog({ kind: 'delete', sessionId, displayTitle }) }
      }, '彻底删除会话…')
    }

    // ------------------------------------------------------------ dialog pieces
    const overlayStyle = {
      position: 'fixed', inset: 0, zIndex: 3000, display: 'flex',
      alignItems: 'center', justifyContent: 'center', background: 'rgba(0, 0, 0, 0.45)'
    }
    const panelStyle = {
      width: 'min(520px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 96px)', overflow: 'auto',
      background: 'var(--dsw-alias-bg-overlay, #1f1f1f)', color: 'var(--dsw-alias-label-primary)',
      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))', borderRadius: 12,
      padding: '18px 20px', boxShadow: '0 16px 48px rgba(0, 0, 0, 0.45)', fontSize: 13, lineHeight: 1.6
    }
    const buttonStyle = (variant, disabled) => ({
      height: 30, padding: '0 14px', borderRadius: 8, fontSize: 13, cursor: disabled ? 'default' : 'pointer',
      border: '1px solid ' + (variant === 'danger'
        ? 'var(--dsw-alias-state-error-primary, #e5534b)'
        : 'var(--dsw-alias-border-l1, rgba(255,255,255,.14))'),
      background: variant === 'danger'
        ? 'var(--dsw-alias-state-error-primary, #e5534b)'
        : 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))',
      color: variant === 'danger' ? '#fff' : 'var(--dsw-alias-label-primary)',
      opacity: disabled ? 0.55 : 1
    })
    const noteStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
    const errorStyle = { color: 'var(--dsw-alias-state-error-primary, #e5534b)', fontSize: 12, whiteSpace: 'pre-wrap' }
    const listStyle = { margin: '8px 0 0', paddingLeft: 18, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
    const optionStyle = selected => ({
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer',
      background: selected ? 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.08))' : 'transparent'
    })
    const footerStyle = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }

    const Dialog = ({ dialog }) => {
      const [phase, setPhase] = useState('confirm')
      const [error, setError] = useState(null)
      const [result, setResult] = useState(null)
      const [workspaces, setWorkspaces] = useState(null)
      const [fromWorkspaceId, setFromWorkspaceId] = useState(null)
      const [targetId, setTargetId] = useState(null)
      const busy = phase === 'busy'
      const close = () => { if (!busy) closeDialog() }

      useEffect(() => {
        if (dialog.kind !== 'move') return undefined
        let alive = true
        request(`/workspaces?sessionId=${encodeURIComponent(dialog.sessionId)}`)
          .then(value => {
            if (!alive) return
            setWorkspaces(value?.workspaces ?? [])
            setFromWorkspaceId(value?.currentWorkspaceId ?? null)
          })
          .catch(caught => { if (alive) setError(caught.message) })
        return () => { alive = false }
      }, [dialog])

      useEffect(() => {
        const onKeyDown = event => { if (event.key === 'Escape') close() }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      })

      const runMove = async () => {
        if (targetId === null) return
        setPhase('busy'); setError(null)
        try {
          const value = await callApi('/move', { sessionId: dialog.sessionId, targetWorkspaceId: targetId })
          setResult(value)
          setPhase('done')
          refreshLists()
        } catch (caught) { setError(caught.message); setPhase('confirm') }
      }
      const runDelete = async () => {
        setPhase('busy'); setError(null)
        try {
          const value = await callApi('/delete', { sessionId: dialog.sessionId })
          setResult(value)
          setPhase('done')
          refreshLists()
        } catch (caught) { setError(caught.message); setPhase('confirm') }
      }

      const title = dialog.kind === 'delete' ? '彻底删除会话' : '移动到其他工作区'
      const body = []

      if (phase === 'done') {
        if (dialog.kind === 'delete') {
          body.push(h('p', { key: 'done', style: { margin: 0 } }, '会话已彻底删除。'))
          const removed = result?.artifactRemoved
          body.push(h('ul', { key: 'detail', style: listStyle },
            h('li', { key: 'log' }, removed ? `会话日志目录：${removed}` : '会话日志：磁盘上已无记录'),
            h('li', { key: 'gen' }, `日志代次：${result?.generationsRemoved?.length ?? 0} 个`),
            h('li', { key: 'ws' }, `已从 ${result?.detachedFromWorkspaces?.length ?? 0} 个工作区移除`),
            h('li', { key: 'flag' }, `归档标记：${result?.unarchived ? '已清理' : '无'}；收藏标记：${result?.unpinned ? '已清理' : '无'}`),
            h('li', { key: 'cache' },
              `投影缓存：${result?.projectionCache?.recordFiles?.length ?? 0} 个文件` +
              (result?.projectionCache?.aggregateRowPruned ? '，聚合记录 1 行' : ''))
          ))
          if (result?.warnings?.length) {
            body.push(h('p', { key: 'warn', style: errorStyle }, '警告：\n' + result.warnings.join('\n')))
          }
        } else if (result?.moved === false) {
          body.push(h('p', { key: 'done', style: { margin: 0 } }, result.message ?? '会话已属于目标工作区。'))
        } else {
          body.push(h('p', { key: 'done', style: { margin: 0 } }, `已移动到「${result?.toWorkspaceTitle ?? ''}」。`))
          body.push(h('p', { key: 'detail', style: noteStyle },
            `原路径：${result?.artifactFrom ?? ''}\n新路径：${result?.artifactTo ?? ''}`))
        }
        return h('div', { style: overlayStyle, onClick: close },
          h('div', { style: panelStyle, onClick: event => event.stopPropagation() },
            h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, title),
            ...body,
            h('div', { style: footerStyle }, h('button', { type: 'button', style: buttonStyle('plain', false), onClick: close }, '完成'))
          ))
      }

      if (dialog.kind === 'delete') {
        body.push(h('p', { key: 'desc', style: { margin: 0 } },
          '将永久删除「', h('strong', { key: 't' }, dialog.displayTitle || dialog.sessionId), '」，此操作不可恢复。'))
        body.push(h('ul', { key: 'items', style: listStyle },
          h('li', { key: 'log' }, '会话日志文件（全部代次与临时文件）'),
          h('li', { key: 'ws' }, '工作区归属、归档与收藏标记'),
          h('li', { key: 'cache' }, '投影缓存等派生数据')
        ))
      } else {
        body.push(h('p', { key: 'desc', style: { margin: 0 } },
          '把「', h('strong', { key: 't' }, dialog.displayTitle || dialog.sessionId), '」移动到：'))
        if (workspaces === null && error === null) {
          body.push(h('p', { key: 'loading', style: noteStyle }, '正在读取工作区列表…'))
        } else if (workspaces !== null) {
          const options = workspaces.filter(workspace => workspace.id !== fromWorkspaceId)
          if (options.length === 0) {
            body.push(h('p', { key: 'empty', style: noteStyle }, '没有其他工作区可移动。'))
          } else {
            const rows = options.map(workspace => h('label', {
              key: workspace.id,
              style: optionStyle(targetId === workspace.id)
            },
            h('input', {
              type: 'radio',
              name: 'dsh-session-cleaner-target',
              checked: targetId === workspace.id,
              onChange: () => setTargetId(workspace.id)
            }),
            h('span', { key: 'label' }, workspace.title),
            h('span', { key: 'path', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, workspace.path)
            ))
            body.push(h('div', {
              key: 'options',
              style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }
            }, ...rows))
          }
        }
        body.push(h('p', { key: 'note', style: noteStyle },
          '移动会重写会话日志里的工作目录并迁移文件，历史记录保持不变。'))
      }

      if (error !== null) body.push(h('p', { key: 'error', style: errorStyle }, error))

      const confirmDisabled = busy || (dialog.kind === 'move' && targetId === null)
      return h('div', { style: overlayStyle, onClick: close },
        h('div', { style: panelStyle, onClick: event => event.stopPropagation() },
          h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, title),
          ...body,
          h('div', { style: footerStyle },
            h('button', { type: 'button', style: buttonStyle('plain', busy), onClick: close }, '取消'),
            h('button', {
              type: 'button',
              style: buttonStyle(dialog.kind === 'delete' ? 'danger' : 'plain', confirmDisabled),
              disabled: confirmDisabled,
              onClick: dialog.kind === 'delete' ? runDelete : runMove
            }, busy ? '处理中…' : (dialog.kind === 'delete' ? '彻底删除' : '移动'))
          )
        ))
    }

    const DialogHost = () => {
      const dialog = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      if (dialog === null) return null
      return h(Dialog, { key: dialog.token, dialog })
    }

    // ------------------------------------------------------------ plugin
    const apply = ctx => {
      clientCtx = ctx
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-cleaner.move',
        order: 500
      }, MoveRow))
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'session-cleaner.delete',
        order: 600
      }, DeleteRow))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-cleaner.dialog',
        order: 1000
      }, DialogHost))
    }

    exports.apply = apply
    exports.inject = ['slots', 'sessions', 'workspaces']
    return module.exports
  }
})
