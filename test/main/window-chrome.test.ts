import { describe, expect, it, vi } from 'vitest'
import { applyWorkspaceWindowChrome } from '../../src/main/window-chrome.ts'

describe('workspace window chrome', () => {
  it('hides native controls and lock resize when settings takes the floor', () => {
    const win = {
      isDestroyed: () => false,
      setResizable: vi.fn(),
      setMaximizable: vi.fn(),
      setMinimizable: vi.fn(),
      setWindowButtonVisibility: vi.fn()
    }
    applyWorkspaceWindowChrome(win, false)
    expect(win.setResizable).toHaveBeenCalledWith(false)
    expect(win.setMaximizable).toHaveBeenCalledWith(false)
    expect(win.setMinimizable).toHaveBeenCalledWith(false)
    expect(win.setWindowButtonVisibility).toHaveBeenCalledWith(false)
    applyWorkspaceWindowChrome(win, true)
    expect(win.setWindowButtonVisibility).toHaveBeenLastCalledWith(true)
    expect(win.setResizable).toHaveBeenLastCalledWith(true)
  })

  it('does nothing after the window is gone', () => {
    const win = {
      isDestroyed: () => true,
      setResizable: vi.fn(),
      setMaximizable: vi.fn(),
      setMinimizable: vi.fn(),
      setWindowButtonVisibility: vi.fn()
    }
    applyWorkspaceWindowChrome(win, false)
    expect(win.setResizable).not.toHaveBeenCalled()
  })
})
