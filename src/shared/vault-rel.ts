const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']

export const VAULT_MEDIA_SCHEME = 'rgent-vault'

export function isVaultImagePath(rel: string): boolean {
  const lower = rel.toLowerCase()
  return IMAGE_EXT.some((ext) => lower.endsWith(ext))
}

export function joinVaultRel(
  noteRelPath: string,
  href: string,
  base: 'note' | 'vault' = 'note'
): string | null {
  const raw = href.trim().replaceAll('\\', '/')
  if (!raw) return null
  if (hasScheme(raw) || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null

  const parts: string[] = []
  if (base === 'note') {
    const posix = noteRelPath.replaceAll('\\', '/').replace(/^\.\//, '')
    parts.push(...posix.split('/').filter(Boolean).slice(0, -1))
  }
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

export function vaultMediaUrl(relPath: string): string {
  return `${VAULT_MEDIA_SCHEME}://media/?p=${encodeURIComponent(relPath)}`
}

export function parseVaultMediaUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${VAULT_MEDIA_SCHEME}:`) return null
    const rel = parsed.searchParams.get('p')
    return rel && rel.length > 0 ? rel : null
  } catch {
    return null
  }
}

function hasScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
}
