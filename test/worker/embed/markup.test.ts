// The embed's own markup is a public API twice over: once as accessibility
// structure the reader depends on, and once as the class names a `bare`-mode site
// styles (#6). Both are asserted here against the markup a browser would actually
// parse, not against the source string.

import { describe, expect, it } from 'vitest'
import { COMMENT_CLASS_NAMES } from '../../../src/render/comments'
import {
  EMBED_CLASS_NAMES,
  EVERY_FRAGMENT,
  composerMarkup,
  pendingBadgeMarkup,
  replyButtonMarkup,
  replyHeaderMarkup,
  retryMarkup,
  widgetMarkup,
} from '../../../src/embed/markup'
import { parseElements, tagNames } from '../render/parse'

/**
 * Every fragment this module can put on somebody's page, concatenated, so that the
 * class-name and vocabulary assertions below see all of it rather than whichever
 * piece a test author remembered. EVERY_FRAGMENT is the module's own list of its
 * builders — a new builder that is not added to it fails the coverage test below.
 */
function everyFragment(): string {
  return EVERY_FRAGMENT.map((build) => build('c1')).join('')
}

async function classNamesIn(html: string): Promise<Set<string>> {
  const elements = await parseElements(html)
  const names = new Set<string>()
  for (const element of elements) {
    for (const name of (element.attributes['class'] ?? '').split(/\s+/)) {
      if (name !== '') names.add(name)
    }
  }
  return names
}

describe('the embed class-name contract', () => {
  // The exact list, written out by hand rather than imported and compared to
  // itself. Bare mode is permission to style these directly (#6), so a rename is a
  // breaking change on somebody else's site that no test of ours would otherwise
  // notice. Changing this array is the review prompt.
  it('is exactly this set of names', () => {
    expect([...EMBED_CLASS_NAMES]).toEqual([
      'charcha-root',
      'charcha-status',
      'charcha-retry',
      'charcha-thread',
      'charcha-comment-actions',
      'charcha-reply-button',
      'charcha-pending',
      'charcha-form',
      'charcha-form-replying',
      'charcha-reply-header',
      'charcha-reply-to',
      'charcha-cancel-reply',
      'charcha-toolbar',
      'charcha-toolbar-button',
      'charcha-fields',
      'charcha-field',
      'charcha-label',
      'charcha-input',
      'charcha-textarea',
      'charcha-hint',
      'charcha-error',
      'charcha-turnstile',
      'charcha-actions',
      'charcha-submit',
    ])
  })

  it('every name is prefixed, so nothing can collide with the host page', () => {
    for (const name of EMBED_CLASS_NAMES) expect(name.startsWith('charcha-')).toBe(true)
  })

  it('emits no class the contract does not declare', async () => {
    const declared = new Set<string>(EMBED_CLASS_NAMES)
    for (const name of await classNamesIn(everyFragment())) {
      expect(declared.has(name), `undeclared class ${name}`).toBe(true)
    }
  })

  it('declares no class name that nothing emits', async () => {
    // The other direction, and the one that rots quietly: a name left in the
    // contract after the markup stopped using it is a promise to site owners that
    // nothing keeps. `charcha-form-replying` is the one exception — JavaScript
    // toggles it on the form rather than any builder emitting it.
    const emitted = await classNamesIn(everyFragment())
    emitted.add('charcha-form-replying')
    for (const name of EMBED_CLASS_NAMES) {
      expect(emitted.has(name), `declared but never emitted: ${name}`).toBe(true)
    }
  })

  it('names every builder in EVERY_FRAGMENT', () => {
    // The coverage above is only as good as this list, so the list is asserted
    // against the module's exports rather than trusted.
    expect(EVERY_FRAGMENT.length).toBe(6)
    for (const build of [
      widgetMarkup,
      composerMarkup,
      replyButtonMarkup,
      pendingBadgeMarkup,
      replyHeaderMarkup,
      retryMarkup,
    ]) {
      expect(EVERY_FRAGMENT).toContain(build)
    }
  })

  it('does not reuse a class name the renderer already owns', () => {
    // Read from the renderer rather than copied, so this cannot pass by being out of
    // date. The renderer's names are its contract and the embed's are the embed's;
    // two owners for one name is how a rename in one file breaks the other silently.
    const rendererOwned = new Set<string>(COMMENT_CLASS_NAMES)
    for (const name of EMBED_CLASS_NAMES) {
      expect(rendererOwned.has(name), `${name} is already the renderer's`).toBe(false)
    }
  })
})

describe('the composer is a real form', () => {
  it('is a form element with a submit button', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    expect(elements.some((element) => element.tag === 'form')).toBe(true)
    expect(
      elements.some(
        (element) => element.tag === 'button' && element.attributes['type'] === 'submit',
      ),
    ).toBe(true)
  })

  it('binds every label to the control it names', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const ids = new Set(
      elements.flatMap((element) => {
        const id = element.attributes['id']
        return id === undefined ? [] : [id]
      }),
    )

    const labels = elements.filter((element) => element.tag === 'label')
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      const target = label.attributes['for']
      expect(target, 'a label with no for attribute names nothing').toBeDefined()
      expect(ids.has(target ?? ''), `label points at missing id ${target ?? ''}`).toBe(true)
    }
  })

  it('points every aria-describedby at an element that exists', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const ids = new Set(
      elements.flatMap((element) => {
        const id = element.attributes['id']
        return id === undefined ? [] : [id]
      }),
    )

    const described = elements.flatMap((element) => {
      const value = element.attributes['aria-describedby']
      return value === undefined ? [] : value.split(/\s+/)
    })
    expect(described.length).toBeGreaterThan(0)
    for (const id of described) expect(ids.has(id), `aria-describedby ${id} is dangling`).toBe(true)
  })

  it('scopes its ids to the instance, so two widgets on one page do not collide', async () => {
    const first = await parseElements(composerMarkup('c1'))
    const second = await parseElements(composerMarkup('c2'))

    const idsOf = (elements: typeof first) =>
      new Set(
        elements.flatMap((element) => {
          const id = element.attributes['id']
          return id === undefined ? [] : [id]
        }),
      )

    const a = idsOf(first)
    const b = idsOf(second)
    expect(a.size).toBeGreaterThan(0)
    for (const id of a) expect(b.has(id), `id ${id} is shared between instances`).toBe(false)
  })

  it('caps every field at the length the server would reject', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const byName = new Map(
      elements.flatMap((element) => {
        const name = element.attributes['name']
        return name === undefined ? [] : ([[name, element]] as const)
      }),
    )

    // The same numbers as src/submit/schema.ts. The browser stopping the reader at
    // the limit is kinder than a 400 after they wrote it, and neither is trusted:
    // maxlength is a hint, the server's cap is the rule.
    expect(byName.get('body')?.attributes['maxlength']).toBe('10000')
    expect(byName.get('authorName')?.attributes['maxlength']).toBe('80')
    expect(byName.get('authorEmail')?.attributes['maxlength']).toBe('254')
  })

  it('marks the required fields required and leaves email optional', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const byName = new Map(
      elements.flatMap((element) => {
        const name = element.attributes['name']
        return name === undefined ? [] : ([[name, element]] as const)
      }),
    )

    expect(byName.get('body')?.attributes['required']).toBeDefined()
    expect(byName.get('authorName')?.attributes['required']).toBeDefined()
    expect(byName.get('authorEmail')?.attributes['required']).toBeUndefined()
  })

  it('says on the email field what the email is for, and that nothing is stored', () => {
    // The one privacy line the design allows, and it is on the field it is about
    // rather than in a banner (#5).
    expect(composerMarkup('c1')).toContain(
      'Optional — for reply notifications, never shown publicly. No account, no cookies.',
    )
  })

  it('gives the toolbar a real toolbar role, pointed at the field it edits', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const toolbar = elements.find((element) => element.attributes['role'] === 'toolbar')
    expect(toolbar).toBeDefined()
    expect(toolbar?.attributes['aria-label']).toBeTruthy()

    const controls = toolbar?.attributes['aria-controls']
    const textarea = elements.find((element) => element.tag === 'textarea')
    expect(controls).toBe(textarea?.attributes['id'])
  })

  it('makes every toolbar control a button that cannot submit the form', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const toolbarButtons = elements.filter((element) =>
      (element.attributes['class'] ?? '').includes('charcha-toolbar-button'),
    )
    expect(toolbarButtons.length).toBeGreaterThan(0)
    for (const button of toolbarButtons) {
      expect(button.tag).toBe('button')
      // A button inside a form defaults to type=submit. One of these left as the
      // default posts a half-written comment the moment the reader clicks Bold.
      expect(button.attributes['type']).toBe('button')
    }
  })

  it('gives the write error a live region that is associated with the field', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const error = elements.find((element) =>
      (element.attributes['class'] ?? '').includes('charcha-error'),
    )
    expect(error?.attributes['role']).toBe('alert')
    // Hidden until there is something to say — an empty alert announced on load is
    // noise, and an always-present empty node reads as a rendering bug.
    expect(error?.attributes['hidden']).toBeDefined()

    const textarea = elements.find((element) => element.tag === 'textarea')
    expect(textarea?.attributes['aria-describedby']).toContain(error?.attributes['id'] ?? '')
  })
})

describe('where the Turnstile widget goes', () => {
  it('gives the composer a container of its own, inside the form', async () => {
    // Inside the form and not beside it, so that a widget mounted as a reply carries
    // its challenge with it — the composer is one live element that moves (#5).
    const elements = await parseElements(composerMarkup('c1'))
    expect(elements.some((element) => element.attributes['class'] === 'charcha-turnstile')).toBe(
      true,
    )
  })

  it('sits between the error and the Post button, where the reader is looking', () => {
    // An interactive challenge appears here, immediately above the action it gates.
    // Anywhere further up and a reader who has to click something never sees it.
    const html = composerMarkup('c1')
    expect(html.indexOf('charcha-turnstile')).toBeGreaterThan(html.indexOf('charcha-error'))
    expect(html.indexOf('charcha-turnstile')).toBeLessThan(html.indexOf('charcha-actions'))
  })

  it('carries no sitekey of its own, because nothing owner-supplied reaches markup', () => {
    // The sitekey is public, so this is not about secrecy. It is that markup.ts is
    // entirely literal, and that is the property which lets mount.ts write it with
    // innerHTML at all. The sitekey travels as a JS argument to turnstile.render.
    expect(composerMarkup('c1')).not.toContain('sitekey')
  })
})

describe('the honeypot', () => {
  it('is named subject, and is empty', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const honeypot = elements.find((element) => element.attributes['name'] === 'subject')
    expect(honeypot).toBeDefined()
    expect(honeypot?.attributes['value']).toBe('')
  })

  it('hides itself without help from the stylesheet', async () => {
    // Bare mode is permission to drop Charcha's CSS entirely (#6), and a spam guard
    // a setting can switch off is not a guard. `hidden` comes from the UA
    // stylesheet, so it survives both bare mode and a host CSP that blocks inline
    // style attributes. Both are present; neither alone is enough.
    const elements = await parseElements(composerMarkup('c1'))
    const honeypot = elements.find((element) => element.attributes['name'] === 'subject')
    expect(honeypot?.attributes['hidden']).toBeDefined()
    expect(honeypot?.attributes['style']).toContain('-9999px')
  })

  it('is out of the tab order, unannounced, and never autofilled', async () => {
    const elements = await parseElements(composerMarkup('c1'))
    const honeypot = elements.find((element) => element.attributes['name'] === 'subject')
    expect(honeypot?.attributes['tabindex']).toBe('-1')
    expect(honeypot?.attributes['aria-hidden']).toBe('true')
    // `subject` is not an HTML autofill token, and `off` is the second lock: a
    // honeypot a browser fills in rejects a real person's comment.
    expect(honeypot?.attributes['autocomplete']).toBe('off')
    expect(
      elements.some(
        (element) =>
          element.tag === 'label' && element.attributes['for'] === honeypot?.attributes['id'],
      ),
    ).toBe(false)
  })
})

describe('the markup vocabulary', () => {
  it('emits no element that can execute or load anything', async () => {
    // The embed writes this markup with innerHTML. Nothing here is built from
    // reader input — that is the rule, and this is the assertion that says so about
    // the output rather than about the intent.
    const tags = await tagNames(everyFragment())
    for (const forbidden of ['script', 'iframe', 'object', 'embed', 'link', 'style', 'img']) {
      expect(tags.has(forbidden), `${forbidden} must never appear in embed markup`).toBe(false)
    }
  })

  it('carries no inline event handler', async () => {
    const elements = await parseElements(everyFragment())
    for (const element of elements) {
      for (const name of Object.keys(element.attributes)) {
        expect(name.startsWith('on'), `inline handler ${name}`).toBe(false)
      }
    }
  })
})

describe('the widget shell', () => {
  it('gives the reader a polite live region for the read state', async () => {
    const elements = await parseElements(widgetMarkup('c1'))
    const status = elements.find((element) =>
      (element.attributes['class'] ?? '').includes('charcha-status'),
    )
    expect(status?.attributes['role']).toBe('status')
    expect(status?.attributes['aria-live']).toBe('polite')
  })

  it('has somewhere for the fetched comments to land', async () => {
    const classes = await classNamesIn(widgetMarkup('c1'))
    expect(classes.has('charcha-thread')).toBe(true)
  })
})
