import DOMPurify from 'dompurify'

const HTML_TAGS = [
  'p', 'div', 'span', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'kbd', 'sup', 'sub'
]

/** Markdown HTML is library content. Render only inert typography, never application UI. */
export function renderSafeHtmlFragment(raw: string): DocumentFragment {
  const clean = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: HTML_TAGS,
    ALLOWED_ATTR: [],
    RETURN_DOM_FRAGMENT: true
  })
  // Unsupported elements remain inspectable as source; do not silently delete them.
  if (DOMPurify.removed.some((item) => 'element' in item && item.element.nodeName !== 'BODY')) {
    const literal = document.createDocumentFragment()
    literal.append(document.createTextNode(raw))
    return literal
  }
  return clean
}
