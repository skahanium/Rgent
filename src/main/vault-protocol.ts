import path from 'node:path'
import { protocol } from 'electron'
import { parseVaultMediaUrl, VAULT_MEDIA_SCHEME } from '../shared/vault-rel.ts'
import { readVaultMedia } from './paths.ts'
import type { VaultSession } from './vault.ts'

export function registerVaultScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VAULT_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}

export function attachVaultProtocol(getVault: () => VaultSession | null): void {
  protocol.handle(VAULT_MEDIA_SCHEME, (request) => {
    const rel = parseVaultMediaUrl(request.url)
    if (!rel) return new Response('', { status: 400 })
    const root = getVault()?.root
    if (!root) return new Response('', { status: 404 })
    const resolved = readVaultMedia(root, rel)
    if ('error' in resolved) return new Response('', { status: resolved.error })
    return new Response(new Uint8Array(resolved.bytes), {
      headers: { 'content-type': contentType(rel) }
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
