/** 工作区才保留原生缩放／关闭。设置打开时由主进程收起，渲染层遮罩盖不到标题栏覆盖层。 */

export type WorkspaceWindow = {
  isDestroyed(): boolean
  setResizable(resizable: boolean): void
  setMaximizable(maximizable: boolean): void
  setMinimizable(minimizable: boolean): void
  setWindowButtonVisibility?(visible: boolean): void
}

export function applyWorkspaceWindowChrome(win: WorkspaceWindow, interactive: boolean): void {
  if (win.isDestroyed()) return
  win.setResizable(interactive)
  win.setMaximizable(interactive)
  win.setMinimizable(interactive)
  try { win.setWindowButtonVisibility?.(interactive) }
  catch { /* Linux 或未开 titleBarOverlay 时没有这三个钮 */ }
}
