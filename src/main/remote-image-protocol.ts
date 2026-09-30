import { protocol } from 'electron'
import { parseRemoteImageUrl, REMOTE_IMAGE_SCHEME, type RemoteImageService } from './remote-image.ts'

export function attachRemoteImageProtocol(service: RemoteImageService): void {
  protocol.handle(REMOTE_IMAGE_SCHEME, (request) => {
    const token = parseRemoteImageUrl(request.url)
    // Chromium leaves destination empty for this custom-scheme <img> request.
    if (!token || (request.destination && request.destination !== 'image')) return new Response('', { status: 403 })
    const image = service.read(token)
    if (!image) return new Response('', { status: 404 })
    return new Response(new Uint8Array(image.bytes), {
      headers: { 'content-type': image.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
        'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" }
    })
  })
}
