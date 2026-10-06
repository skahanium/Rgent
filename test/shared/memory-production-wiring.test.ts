import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MEMORY_PIPELINE, MEMORY_PRODUCTION_STRATEGY } from '../../src/shared/memory.ts'

/**
 * 生产整理口径是产品行为：r9 认证后普通入口固定走共同管线，旧提议解析只留给历史评测臂。
 * 这层薄包装依赖 Electron，不方便直接单测；按 `ipc-channel.test.ts` 的既有做法扫源码，
 * 钉住「生产里每个构造点都显式带上受认证的策略」，同时钉住历史入口不能由生产引用；普通构造省略策略也走 M4。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) return sourceFiles(file)
    return file.endsWith('.ts') ? [file] : []
  })
}

/** 注释里说明"旧路径留给历史评测臂"是允许的：先去掉注释再找真实引用。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 取 `new WorkingMemoryConsolidation(` 起、括号配平为止的构造实参文本。 */
function constructions(text: string): string[] {
  const found: string[] = []
  const marker = 'new WorkingMemoryConsolidation('
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
    let depth = 0
    for (let i = at + marker.length - 1; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) { found.push(text.slice(at, i + 1)); break }
      }
    }
  }
  return found
}

const consolidationModule = path.join('main', 'working-memory-consolidation.ts')
const allProduction = sourceFiles(path.join(root, 'src'))
  .filter((file) => !file.endsWith(consolidationModule))
  .map((file) => ({ file: path.relative(root, file), text: readFileSync(file, 'utf8') }))
const constructionSites = allProduction
  .map((entry) => ({ file: entry.file, constructions: constructions(stripComments(entry.text)) }))
  .filter((entry) => entry.constructions.length > 0)


describe('production memory consolidation wiring', () => {
  it('constructs the engine with the certified strategy everywhere in production', () => {
    expect(MEMORY_PRODUCTION_STRATEGY).toBe('continuity')
    expect(MEMORY_PIPELINE).toBe('continuity-m4')
    expect(constructionSites.length).toBeGreaterThan(0)
    for (const entry of constructionSites) {
      for (const call of entry.constructions) {
        expect(call, `${entry.file} 的构造没有显式带上 MEMORY_PRODUCTION_STRATEGY`).toContain('MEMORY_PRODUCTION_STRATEGY')
      }
    }
  })
  it('leaves the retired proposal prompt and parser out of every production source', () => {
    for (const entry of allProduction) {
      const code = stripComments(entry.text)
      expect(code, `${entry.file} 仍引用已退役的整理提示`).not.toContain('memoryConsolidationSystem')
      expect(code, `${entry.file} 仍引用已退役的提议解析`).not.toContain('parseMemorySuggestions')
      expect(code, `${entry.file} 仍调用历史评测入口`).not.toContain('forHistoricalEvaluation')
    }
  })
})
