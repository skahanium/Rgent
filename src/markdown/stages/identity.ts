import type { MarkdownStage } from './stage.ts'
import { transformIdentity } from '../syntax/identity.ts'

/**
 * 排在最后：它要看见其它变换之后的最终结构（callout 会把 blockquote 换成一个新节点，
 * 早跑就会把身份挂在被换掉的那个节点上）。
 */
export const identityStage: MarkdownStage = {
  id: 'identity',
  transform: transformIdentity
}
