import { codes } from 'micromark-util-symbol'

type Effects = {
  enter: (type: string) => void
  exit: (type: string) => void
  consume: (code: number) => void
}

type State = (code: number | null) => State | undefined

type Ok = State
type Nok = State

type Compile = {
  enter: (node: object, token: unknown) => void
  exit: (token: unknown) => void
  sliceSerialize: (token: unknown) => string
  stack: Array<{
    type: string
    embed?: boolean
    value?: string
    target?: string
    display?: string
  }>
}

export function wikiTarget(raw: string): string {
  const posix = raw.trim().replaceAll('\\', '/')
  if (!posix) return ''
  const base = posix.split('/').pop() ?? posix
  if (!base.includes('.') || base.endsWith('.')) return `${posix}.md`
  return posix
}

export function wikiDisplay(raw: string): string {
  const posix = raw.trim().replaceAll('\\', '/')
  const base = posix.split('/').pop() ?? posix
  return base.replace(/\.md$/i, '')
}

export function wikilinkSyntax(): unknown {
  return {
    text: {
      [codes.leftSquareBracket]: { name: 'wikilink', tokenize: tokenizeWikilink },
      [codes.exclamationMark]: { name: 'wikilinkEmbed', tokenize: tokenizeEmbed }
    }
  }
}

export function wikilinkFromMarkdown(): unknown {
  return {
    enter: {
      wikilink: function enterWikilink(this: Compile, token: unknown) {
        this.enter(
          { type: 'wikilink', embed: false, value: '', target: '', display: '' },
          token
        )
      }
    },
    exit: {
      wikilink: function exitWikilink(this: Compile, token: unknown) {
        const raw = this.sliceSerialize(token)
        const node = this.stack[this.stack.length - 1]
        const embed = raw.startsWith('!')
        const inner = (embed ? raw.slice(3) : raw.slice(2)).replace(/\]\]$/, '')
        node.embed = embed
        node.value = inner
        node.target = wikiTarget(inner)
        node.display = wikiDisplay(inner)
        this.exit(token)
      }
    }
  }
}

function tokenizeWikilink(effects: Effects, ok: Ok, nok: Nok): State {
  return tokenize(false, effects, ok, nok)
}

function tokenizeEmbed(effects: Effects, ok: Ok, nok: Nok): State {
  return tokenize(true, effects, ok, nok)
}

function tokenize(embed: boolean, effects: Effects, ok: Ok, nok: Nok): State {
  return start

  function start(code: number | null): State | undefined {
    if (embed) {
      if (code !== codes.exclamationMark) return nok(code)
      effects.enter('wikilink')
      effects.consume(code)
      return afterBang
    }
    if (code !== codes.leftSquareBracket) return nok(code)
    effects.enter('wikilink')
    effects.consume(code)
    return afterFirst
  }

  function afterBang(code: number | null): State | undefined {
    if (code !== codes.leftSquareBracket) return nok(code)
    effects.consume(code)
    return afterFirst
  }

  function afterFirst(code: number | null): State | undefined {
    if (code !== codes.leftSquareBracket) return nok(code)
    effects.consume(code)
    return data
  }

  function data(code: number | null): State | undefined {
    if (code === codes.eof || isEol(code) || code === codes.rightSquareBracket) return nok(code)
    effects.consume(code)
    return more
  }

  function more(code: number | null): State | undefined {
    if (code === codes.eof || isEol(code)) return nok(code)
    if (code === codes.rightSquareBracket) {
      effects.consume(code)
      return close
    }
    effects.consume(code)
    return more
  }

  function close(code: number | null): State | undefined {
    if (code !== codes.rightSquareBracket) return nok(code)
    effects.consume(code)
    effects.exit('wikilink')
    return ok
  }
}

function isEol(code: number | null): boolean {
  return (
    code === codes.carriageReturn ||
    code === codes.lineFeed ||
    code === codes.carriageReturnLineFeed
  )
}
