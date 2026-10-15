import path from 'node:path'
import { protocol } from 'electron'
import { parseVaultMediaUrl, VAULT_MEDIA_SCHEME } from '../shared/vault-rel.ts'
import { readVaultMedia } from './paths.ts'
import type { VaultSession } from './vault.ts'

export function attachVaultProtocol(getVault: () => VaultSession | null): void {
  protocol.handle(VAULT_MEDIA_SCHEME, (request) => {
    const rel = parseVaultMediaUrl(request.url)
    // Chromium leaves destination empty for this custom-scheme <img> request.
    if (!rel || (request.destination && request.destination !== 'image')) return new Response('', { status: 403 })
    let root: string
    try { const current = getVault()!; const session = new URL(request.url).searchParams.get('s'); if (!session || session !== current.sessionId()) return new Response('', { status: 410 }); root = current.requireUsableRoot() } catch { return new Response('', { status: 404 }) }
    const resolved = readVaultMedia(root, rel)
    if ('error' in resolved) return new Response('', { status: resolved.error })
    return new Response(new Uint8Array(resolved.bytes), {
      headers: {
        'content-type': contentType(rel),
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'"
      }
    })
  })
}

function contentType(relPath: string): string {
  switch (path.extname(relPath).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.svg': return 'image/svg+xml'
    case '.bmp': return 'image/bmp'
    case '.avif': return 'image/avif'
    default: return 'application/octet-stream'
  }
}
