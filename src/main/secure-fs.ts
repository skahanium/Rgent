import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type NativeEntry = { name: string; kind: 'dir' | 'file' | 'link' | 'other'; size: number; mtimeMs: number }
export type ResolvedComponent = { name: string; id: string; kind: 'dir' | 'file' }

type NativeBinding = {
  openRoot(root: string): unknown
  closeRoot(root: unknown): void
  list(root: unknown, relDir: string): NativeEntry[]
  resolve(root: unknown, relPath: string): ResolvedComponent[]
  read(root: unknown, relPath: string): Buffer
  replace(root: unknown, relPath: string, expected: Buffer | null, content: Buffer): void
  create(root: unknown, relPath: string): void
}

const here = path.dirname(fileURLToPath(import.meta.url))
const nativeFile = here.endsWith(`${path.sep}src${path.sep}main`)
  ? path.resolve(here, '../../build/Release/rgent_fs.node')
  : path.join(here, 'rgent_fs.node')
const binding = createRequire(import.meta.url)(nativeFile) as NativeBinding

export class SecureVaultFs {
  private handle: unknown

  constructor(root: string) {
    this.handle = binding.openRoot(realpathSync(root))
  }

  list(relDir = ''): NativeEntry[] {
    return binding.list(this.handle, relDir)
  }

  resolve(relPath: string): ResolvedComponent[] {
    return binding.resolve(this.handle, relPath)
  }

  readBytes(relPath: string): Buffer {
    return binding.read(this.handle, relPath)
  }

  readText(relPath: string): string {
    return this.readBytes(relPath).toString('utf8')
  }

  replace(relPath: string, expected: string | null, content: string): void {
    binding.replace(this.handle, relPath, expected === null ? null : Buffer.from(expected, 'utf8'), Buffer.from(content, 'utf8'))
  }

  create(relPath: string): void {
    binding.create(this.handle, relPath)
  }

  close(): void {
    binding.closeRoot(this.handle)
  }
}

const sessions = new Map<string, SecureVaultFs>()

export function secureFsFor(root: string): SecureVaultFs {
  const key = path.resolve(root)
  let session = sessions.get(key)
  if (!session) {
    session = new SecureVaultFs(key)
    sessions.set(key, session)
  }
  return session
}

export function closeSecureFs(root: string): void {
  const key = path.resolve(root)
  const session = sessions.get(key)
  if (session) {
    session.close()
    sessions.delete(key)
  }
}
