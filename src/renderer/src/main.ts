import './styles.css'
import { start } from './shell.ts'
import { watchTheme } from './theme.ts'

const root = document.getElementById('app')
if (!root) throw new Error('missing #app')

// Window chrome shares this one row with tabs. No renderer IPC is needed for layout.
document.documentElement.dataset.platform = navigator.platform.startsWith('Mac') ? 'darwin' :
  navigator.platform.startsWith('Win') ? 'win32' : 'other'

// 主题只跟随系统；窗口创建前先落一次，避免闪一下日间配色。
watchTheme((theme) => {
  window.dispatchEvent(new CustomEvent('rgent:theme', { detail: theme }))
})

void start(root)
