/**
 * Reads rendered HTML back with a real HTML parser rather than a regex.
 *
 * A renderer test that only greps the output string for `<script` agrees with
 * every mistake the browser would make differently — unclosed tags, implied
 * elements, attributes the parser invents while recovering from malformed
 * markup. HTMLRewriter is the parser workerd already ships, so these tests ask
 * the same question a browser would: which elements and attributes actually
 * exist in this document?
 *
 * Attribute values come back as written rather than as they decode — `&amp;`
 * stays `&amp;` — which is the stricter view for a security assertion: it is
 * what actually sits in the document.
 */
export interface ParsedElement {
  tag: string
  attributes: Record<string, string>
}

export async function parseElements(html: string): Promise<ParsedElement[]> {
  const elements: ParsedElement[] = []

  const response = new HTMLRewriter()
    .on('*', {
      element(element) {
        const attributes: Record<string, string> = {}
        for (const attribute of element.attributes) {
          attributes[attribute[0] ?? ''] = attribute[1] ?? ''
        }
        elements.push({ tag: element.tagName, attributes })
      },
    })
    .transform(new Response(html))

  // The rewriter parses lazily: nothing is visited until the body is consumed.
  await response.text()
  return elements
}

/** Every attribute name present anywhere in the document, lowercased. */
export async function attributeNames(html: string): Promise<Set<string>> {
  const elements = await parseElements(html)
  return new Set(elements.flatMap((element) => Object.keys(element.attributes)))
}

/** Every tag name present anywhere in the document, lowercased. */
export async function tagNames(html: string): Promise<Set<string>> {
  const elements = await parseElements(html)
  return new Set(elements.map((element) => element.tag))
}
