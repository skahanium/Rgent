import type { Literal, Parent } from 'mdast'
import type { CalloutKind } from '../types.ts'
import 'mdast-util-math'

export interface CalloutNode extends Parent {
  type: 'callout'
  kind: CalloutKind
  title: string
}

export interface WikiLinkNode extends Literal {
  type: 'wikilink'
  embed: boolean
  target: string
  display: string
}

declare module 'mdast' {
  interface BlockContentMap {
    callout: CalloutNode
  }

  interface PhrasingContentMap {
    wikilink: WikiLinkNode
  }

  interface RootContentMap {
    callout: CalloutNode
    wikilink: WikiLinkNode
  }
}
