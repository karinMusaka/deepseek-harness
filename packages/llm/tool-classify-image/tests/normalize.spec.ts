/**
 * Marker normalization, including the ordering hazard the gender rule exists
 * for: `female` contains `male` and `woman` contains `man`, so a male-first
 * scan would mislabel every female answer.
 */

import { describe, expect, it } from 'vitest'
import { normalizeImageGender, normalizeImageType } from '../src/normalize.ts'

describe('normalizeImageType', () => {
  it.each([
    ['This is a digital illustration of a young character.', 'illustration'],
    ['It looks like an anime style artwork.', 'illustration'],
    ['This appears to be a pencil drawing.', 'illustration'],
    ['The image is a cartoon character.', 'illustration'],
    ['This is digital art created in a painting app.', 'illustration'],
    ['ILLUSTRATION, clearly.', 'illustration'],
  ] as const)('reads %j as an illustration', (answer, expected) => {
    expect(normalizeImageType(answer)).toBe(expected)
  })

  it.each([
    ['This is a real photograph taken outdoors.', 'photo'],
    ['It is a photo of a person.', 'photo'],
    ['A Photographic portrait.', 'photo'],
  ] as const)('reads %j as a photo', (answer, expected) => {
    expect(normalizeImageType(answer)).toBe(expected)
  })

  it('reports unknown when the answer names both families', () => {
    expect(normalizeImageType('This is not a photograph, it is an illustration.')).toBe('unknown')
  })

  it('reports unknown when the answer names neither family', () => {
    expect(normalizeImageType('I cannot tell what this depicts.')).toBe('unknown')
  })
})

describe('normalizeImageGender', () => {
  it.each([
    ['The person appears to be female.', 'female'],
    ['This is a young woman.', 'female'],
    ['The character is a girl.', 'female'],
    ['FEMALE.', 'female'],
  ] as const)('reads %j as female', (answer, expected) => {
    expect(normalizeImageGender(answer)).toBe(expected)
  })

  it.each([
    ['The person appears to be male.', 'male'],
    ['This is an older man.', 'male'],
    ['The character is a boy.', 'male'],
  ] as const)('reads %j as male', (answer, expected) => {
    expect(normalizeImageGender(answer)).toBe(expected)
  })

  it('prefers the female reading when both substrings are present', () => {
    // "female" contains "male" and "woman" contains "man": a male-first scan
    // would answer male for both of these.
    expect(normalizeImageGender('The subject is female.')).toBe('female')
    expect(normalizeImageGender('The subject is a woman.')).toBe('female')
  })

  it('reports unknown when the answer names no gender', () => {
    expect(normalizeImageGender('The subject is a cat.')).toBe('unknown')
  })
})
