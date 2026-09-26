import path from 'node:path'
import { isVaultImagePath } from '../shared/vault-rel.ts'
import { secureFsFor } from './secure-fs.ts'

export { isVaultImagePath }

export function toPosixRel(rel: string): string {
  return rel.replaceAll('\\', '/').replace(/^\.\//, '')
}

export function resolveInVault(root: string, relPath: string): string | null {
  const posix = toPosixRel(relPath)
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) return null
  const parts = posix.split('/').filter((part) => part && part !== '.')
  if (parts.some((part) => part === '..')) return null
  const rootAbs = path.resolve(root)
  const abs = parts.length === 0 ? rootAbs : path.resolve(rootAbs, ...parts)
  const relative = path.relative(rootAbs, abs)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return abs
}

export function relFromAbs(root: string, abs: string): string {
  return toPosixRel(path.relative(path.resolve(root), path.resolve(abs)))
}

export function isHiddenName(name: string): boolean {
  return name.startsWith('.')
}

export function hasHiddenSegment(relPath: string): boolean {
  return toPosixRel(relPath).split('/').some((part) => part.startsWith('.'))
}

export function isNotePath(relPath: string): boolean {
  return toPosixRel(relPath).toLowerCase().endsWith('.md')
}

export function vaultMediaPath(root: string, relPath: string): string | null {
  if (!isVaultImagePath(relPath)) return null
  // 与 writeNote / readNote 同一口径：点号路径是应用自己的地盘（权限名单、技能），
  // 不许经 rgent-vault: 协议露给画布。原生层允许点号名（它要读名单），所以挡在
  // 这里——这是隐藏路径唯一没设防的入口。
  if (hasHiddenSegment(relPath)) return null
  return resolveInVault(root, relPath)
}

export function readVaultMedia(root: string, relPath: string): { bytes: Buffer } | { error: 403 | 404 } {
  if (!vaultMediaPath(root, relPath)) return { error: 403 }
  try {
    return { bytes: secureFsFor(root).readBytes(relPath) }
  } catch (error) {
    return { error: error instanceof Error && error.message === 'ENOENT' ? 404 : 403 }
  }
}

export function sanitizeNoteName(name: string): string {
  const trimmed = name.trim()
  const withoutExt = trimmed.replace(/\.md$/i, '')
  const safe = withoutExt.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/u, '_')
  const file = safe.length === 0 ? '未命名' : safe
  return `${file}.md`
}
