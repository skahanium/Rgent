import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { parseVaultMediaUrl, VAULT_MEDIA_SCHEME } from '../shared/vault-rel.ts'
import { resolveVaultMediaFile } from './paths.ts'
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
    const resolved = resolveVaultMediaFile(root, rel)
    if ('error' in resolved) return new Response('', { status: resolved.error })
    return net.fetch(pathToFileURL(resolved.abs).href)
  })
}
