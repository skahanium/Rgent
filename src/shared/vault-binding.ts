/** The envelope is a mount binding, not a source permission. Main still verifies every request. */
export function isVaultChannel(channel: string): boolean {
  return /^(note|folder|tree|permissions|lifecycle|ledger|memory|agent|image):/.test(channel) || channel === 'vault:search'
}

export function boundEvent(value: unknown, session: string | null): unknown[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const envelope = value as Record<string, unknown>
  if (envelope.session !== session || !Array.isArray(envelope.args)) return null
  return envelope.args
}

export function boundArguments(args: unknown[], session: string | null): unknown[] {
  const unpacked = args.length === 1 ? boundEvent(args[0], session) : null
  if (!unpacked) throw Error('VAULT_CHANGED')
  return unpacked
}

export function isVaultEvent(channel: string): boolean {
  return ['tree:changed','note:relocated','note:external-change','vault:lost','memory:changed','agent:event','agent:write-request'].includes(channel)
}
