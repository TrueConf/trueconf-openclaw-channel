import { describe, expect, it } from 'vitest'
import { markdownToTrueconfHtml, renderForSending } from '../../src/format'

const NBSP = '\u00a0'

describe('markdownToTrueconfHtml', () => {
  it('turns line breaks into <br> and keeps at most one blank line', () => {
    expect(markdownToTrueconfHtml('\n  \na\nb\n\n\n\nc\n\n')).toBe('a<br>b<br><br>c')
  })

  it('renders emphasis as TrueConf tags', () => {
    expect(markdownToTrueconfHtml('**b** *i* __B__ _i_ ~~s~~ ***bi***')).toBe(
      '<b>b</b> <i>i</i> <b>B</b> <i>i</i> <s>s</s> <b><i>bi</i></b>',
    )
  })

  it('leaves identifiers and arithmetic alone', () => {
    expect(markdownToTrueconfHtml('snake_case_name and 2 * 3 * 4')).toBe('snake_case_name and 2 * 3 * 4')
  })

  it('escapes html but keeps valid entities', () => {
    expect(markdownToTrueconfHtml('if a < b && c > d, AT&T &amp; &nbsp;')).toBe(
      'if a &lt; b &amp;&amp; c &gt; d, AT&amp;T &amp; &nbsp;',
    )
  })

  it('passes supported tags through, escapes the rest, and turns <br> into breaks', () => {
    expect(markdownToTrueconfHtml('<b>x</b> <div>y</div> line<br>next &lt;br/&gt;end')).toBe(
      '<b>x</b> &lt;div&gt;y&lt;/div&gt; line<br>next<br>end',
    )
  })

  it('keeps code verbatim with its indentation', () => {
    expect(markdownToTrueconfHtml('run `a_b*c*` now\n```py\nif x < 1:\n    y = **2**\n```')).toBe(
      `run a_b*c* now<br>if x &lt; 1:<br>${NBSP.repeat(4)}y = **2**`,
    )
  })

  it('renders links with escaped hrefs and strips autolink brackets', () => {
    expect(markdownToTrueconfHtml('[docs](https://ex.com/a_b?x=1&y="2") and <https://ex.com/z_z_>')).toBe(
      '<a href="https://ex.com/a_b?x=1&amp;y=&quot;2&quot;">docs</a> and https://ex.com/z_z_',
    )
    expect(markdownToTrueconfHtml('**[bold link](https://ex.com)** [local](./path)')).toBe(
      '<b><a href="https://ex.com">bold link</a></b> [local](./path)',
    )
  })

  it('renders headings, lists, quotes, and rules line by line', () => {
    expect(markdownToTrueconfHtml('# Title\n- one\n  - nested\n1. first\n> quote *it*\n---\ntext')).toBe(
      `<b>Title</b><br>• one<br>${NBSP.repeat(2)}◦ nested<br>1. first<br><i>quote <i>it</i></i><br>──────────<br>text`,
    )
  })

  it('renders a table as a bold header and bulleted rows', () => {
    expect(markdownToTrueconfHtml('| Name | Size |\n|---|:---:|\n| a | **1** |\n| b | 2 |\nafter')).toBe(
      '<b>Name — Size</b><br>• a — <b>1</b><br>• b — 2<br>after',
    )
  })

  it('returns an empty string for empty input', () => {
    expect(markdownToTrueconfHtml('')).toBe('')
  })
})

describe('renderForSending', () => {
  it('splits markdown before rendering so tags stay whole', () => {
    expect(renderForSending(`**${'a'.repeat(10)}**\n\n**${'b'.repeat(10)}**`, 20)).toEqual([
      `<b>${'a'.repeat(10)}</b>`,
      `<b>${'b'.repeat(10)}</b>`,
    ])
  })

  it('re-splits a chunk whose html outgrows the limit', () => {
    expect(renderForSending('<'.repeat(30), 40)).toEqual(Array(3).fill('&lt;'.repeat(10)))
  })

  it('keeps a single empty chunk for empty input', () => {
    expect(renderForSending('')).toEqual([''])
  })
})
