/**
 * Small English-surface helpers for the sentences Drift writes about a change.
 *
 * Evidence text is the product: "`glob.IGlobBase` is no longer exported (was a
 * interface)" is the same finding as the correct sentence, and it reads like
 * output nobody looked at — which is exactly the wrong impression for a tool
 * whose whole claim is that every line came from somewhere real. The kinds
 * being described (`interface`, `enum`, `annotation`, `unknown`) are the ones
 * that need "an", and they are decided at runtime from a parsed artifact, so
 * the article cannot be written into the template beside them.
 */

/**
 * `a` or `an` for a following word, by its first sound.
 *
 * Spelling is the rule here, not pronunciation: the words this is ever asked
 * about are declaration kinds from a type system — `interface`, `enum`,
 * `annotation`, `object`, `alias` — and none of them is one of English's
 * exceptions (`a union`, `an hour`). Guessing at pronunciation for words that
 * never arrive would be more machinery than the job has.
 */
export function articleFor(word: string): string {
  return /^[aeiou]/i.test(word.trim()) ? 'an' : 'a';
}

/** `"an interface"`, `"a function"` — the article and the word together. */
export function withArticle(word: string): string {
  return `${articleFor(word)} ${word}`;
}
