import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'build', 'Release', 'rgent_fs.node')
const target = path.join(root, 'out', 'main', 'rgent_fs.node')
mkdirSync(path.dirname(target), { recursive: true })
copyFileSync(source, target)
