import path from 'node:path'
import { isVaultImagePath } from '../shared/vault-rel.ts'

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
  return resolveInVault(root, relPath)
}

export function sanitizeNoteName(name: string): string {
  const trimmed = name.trim()
  const withoutExt = trimmed.replace(/\.md$/i, '')
  const safe = withoutExt.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/u, '_')
  const file = safe.length === 0 ? '未命名' : safe
  return `${file}.md`
}
