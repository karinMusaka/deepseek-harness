/**
 * Keyword normalization from one auxiliary vision model's free prose into the
 * closed labels `classify_image` returns. The vision model is asked for one
 * sentence, not a label, because small local models follow prose instructions
 * far more reliably than a format constraint; this module is the whole
 * translation from that sentence to a label.
 * @module @deepseek-ai/dsh-tool-classify-image/normalize
 */

/** Whether the subject is a captured photograph or a drawn image. */
export type ImageSubjectType = 'photo' | 'illustration' | 'unknown'

/** The apparent gender of the depicted person or character. */
export type ImageSubjectGender = 'male' | 'female' | 'unknown'

/** Markers of a drawn image; `digital art` is two words, so matching is on the raw lowercased text. */
const ILLUSTRATION_MARKERS: readonly string[] = ['illustration', 'anime', 'drawing', 'cartoon', 'digital art']

/** Marker of a captured image. `photo` subsumes `photograph` and `photographic` as a substring. */
const PHOTO_MARKERS: readonly string[] = ['photo']

/**
 * Female markers, tested before {@link MALE_MARKERS} because `female` contains
 * `male` and `woman` contains `man`: reversing the order would label every
 * female answer male.
 */
const FEMALE_MARKERS: readonly string[] = ['female', 'woman', 'girl']

/** Male markers, reachable only after every female marker has been excluded. */
const MALE_MARKERS: readonly string[] = ['male', 'man', 'boy']

/** Whether any marker occurs in the already-lowercased answer. */
function matches(text: string, markers: readonly string[]): boolean {
  return markers.some(marker => text.includes(marker))
}

/**
 * Classify the photograph-or-illustration answer.
 * @param answer - the vision model's raw sentence.
 * @returns `photo` or `illustration` when exactly one family of markers is
 *   present, and `unknown` when the answer names both or neither.
 */
export function normalizeImageType(answer: string): ImageSubjectType {
  const text = answer.toLowerCase()
  const illustration = matches(text, ILLUSTRATION_MARKERS)
  const photo = matches(text, PHOTO_MARKERS)
  // A sentence naming both families ("not a photo, but an illustration") is
  // ambiguous to substring matching, so it reports no answer rather than a
  // coin flip.
  if (illustration && photo) return 'unknown'
  if (illustration) return 'illustration'
  if (photo) return 'photo'
  return 'unknown'
}

/**
 * Classify the apparent-gender answer.
 * @param answer - the vision model's raw sentence.
 * @returns `female` when any female marker is present, `male` when only male
 *   markers are, and `unknown` when neither is.
 */
export function normalizeImageGender(answer: string): ImageSubjectGender {
  const text = answer.toLowerCase()
  if (matches(text, FEMALE_MARKERS)) return 'female'
  if (matches(text, MALE_MARKERS)) return 'male'
  return 'unknown'
}
