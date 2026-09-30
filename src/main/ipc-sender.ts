type Frame = { readonly url: string; readonly detached: boolean; isDestroyed(): boolean }
type Contents = { readonly mainFrame: Frame; getURL(): string; isDestroyed(): boolean }
type Window = { readonly webContents: Contents; isDestroyed(): boolean }
type Event = { readonly sender: Contents; readonly senderFrame: Frame | null }

export function isTrustedIpcSender(event: Event, window: Window | null, trustedEntryUrl: string): boolean {
  try {
    if (!window || window.isDestroyed()) return false
    const contents = window.webContents
    if (contents.isDestroyed() || event.sender !== contents) return false
    const frame = event.senderFrame
    return !!frame && frame === contents.mainFrame && !frame.isDestroyed() && !frame.detached &&
      frame.url === trustedEntryUrl && contents.getURL() === trustedEntryUrl
  } catch { return false }
}
