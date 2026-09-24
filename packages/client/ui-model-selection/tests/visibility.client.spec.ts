import { describe, expect, it } from 'vitest'
import type { ModelProviderGroup, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { filterGroups, isModelHidden } from '../src/client/visibility.ts'

const GROUPS: ModelProviderGroup[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'other',
    name: 'Other',
    models: [{ id: 'model-a', name: 'Model A' }],
  },
]

describe('isModelHidden', () => {
  it('reports a listed model as hidden', () => {
    expect(isModelHidden({ 'deepseek-official': ['deepseek-v4-pro'] }, 'deepseek-official', 'deepseek-v4-pro')).toBe(true)
  })

  it('reports an unlisted model as not hidden', () => {
    expect(isModelHidden({ 'deepseek-official': ['deepseek-v4-pro'] }, 'deepseek-official', 'deepseek-v4-flash')).toBe(false)
  })

  it('reports not hidden for a provider absent from the preference', () => {
    expect(isModelHidden({}, 'deepseek-official', 'deepseek-v4-flash')).toBe(false)
  })
})

describe('filterGroups', () => {
  it('passes every group through unchanged when nothing is hidden', () => {
    expect(filterGroups(GROUPS, {}, null)).toEqual(GROUPS)
  })

  it('removes a hidden model from its group', () => {
    const result = filterGroups(GROUPS, { 'deepseek-official': ['deepseek-v4-pro'] }, null)
    expect(result[0]?.models.map(m => m.id)).toEqual(['deepseek-v4-flash'])
    expect(result[1]?.models.map(m => m.id)).toEqual(['model-a'])
  })

  it('never hides the exact current provider/model pair', () => {
    const current: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
    const result = filterGroups(GROUPS, { 'deepseek-official': ['deepseek-v4-pro'] }, current)
    expect(result[0]?.models.map(m => m.id)).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro'])
  })

  it('still hides a same-id model under a different provider than the current selection', () => {
    const current: ModelSelection = { provider: 'other', model: 'deepseek-v4-pro' }
    const result = filterGroups(GROUPS, { 'deepseek-official': ['deepseek-v4-pro'] }, current)
    expect(result[0]?.models.map(m => m.id)).toEqual(['deepseek-v4-flash'])
  })

  it('drops a group left with no visible models', () => {
    const result = filterGroups(GROUPS, { other: ['model-a'] }, null)
    expect(result.map(g => g.id)).toEqual(['deepseek-official'])
  })

  it('drops a group whose only model is hidden even when a different model is current', () => {
    const current: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    const result = filterGroups(GROUPS, { other: ['model-a'] }, current)
    expect(result.map(g => g.id)).toEqual(['deepseek-official'])
  })
})
