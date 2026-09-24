// @vitest-environment jsdom
/** Model-picker visibility section: render, toggle, bulk toggle, and conflict-reload behavior. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IApiClient, ModelProviderGroup, RpcResponse } from '@deepseek-ai/dsh-api-remotes/client'
import {
  ModelVisibilitySection, writeHiddenModels,
} from '../src/client/ModelVisibilitySection.tsx'
import type { ModelsSettingsState } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: (key: keyof typeof en) => string = key => en[key]

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(code: string, message: string): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: false, error: { code, message, details: {} } as never } }
}

const GROUPS: ModelProviderGroup[] = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
}]

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return {
    status: 'ready', error: null, credentialError: null, writable: true, rows: [], namespaces: new Map(),
    catalogGroups: GROUPS, catalogFailures: [], catalogError: null,
    ...overrides,
  }
}

function withHidden(hidden: Record<string, string[]>, revision = 3): ModelsSettingsState {
  return state({
    namespaces: new Map([
      ['ui-model-selection', {
        ns: 'ui-model-selection', schema: {}, value: { hiddenModels: hidden },
        applies: 'live' as const, secrets: [], revision,
      } as never],
    ]),
  })
}

describe('ModelVisibilitySection', () => {
  it('renders nothing while the catalog is empty and unfailed', () => {
    const { container } = render(
      <ModelVisibilitySection state={state({ catalogGroups: [] })} api={{} as never} t={t} reload={vi.fn()} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('lists every model checked, and shows the unavailable notice without the namespace', () => {
    render(<ModelVisibilitySection state={state()} api={{} as never} t={t} reload={vi.fn()} />)
    expect(screen.getByText(en.visibilityTitle)).toBeTruthy()
    expect(screen.getByText(en.visibilityUnavailable)).toBeTruthy()
    const flash = screen.getByLabelText('DeepSeek-V4-Flash') as HTMLInputElement
    const pro = screen.getByLabelText('DeepSeek-V4-Pro') as HTMLInputElement
    expect(flash.checked).toBe(true)
    expect(pro.checked).toBe(true)
  })

  it('unchecks a hidden model and shows a catalog load failure', () => {
    render(
      <ModelVisibilitySection
        state={withHidden({ 'deepseek-official': ['deepseek-v4-pro'] })}
        api={{} as never}
        t={t}
        reload={vi.fn()}
      />,
    )
    expect(screen.queryByText(en.visibilityUnavailable)).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('DeepSeek-V4-Pro').checked).toBe(false)
  })

  it('shows the catalog load failure text', () => {
    render(
      <ModelVisibilitySection
        state={state({ catalogGroups: [], catalogError: 'llm registry unavailable' })}
        api={{} as never}
        t={t}
        reload={vi.fn()}
      />,
    )
    expect(screen.getByText(`${en.visibilityLoadFailed}: llm registry unavailable`)).toBeTruthy()
  })

  it('shows a provider-local catalog failure beside the loaded groups', () => {
    render(
      <ModelVisibilitySection
        state={state({ catalogFailures: [{ id: 'broken', name: 'Broken', message: 'timed out' }] })}
        api={{} as never}
        t={t}
        reload={vi.fn()}
      />,
    )
    expect(screen.getByText('Broken: timed out')).toBeTruthy()
  })

  it('unchecking a model writes the hidden list under the namespace revision and reloads', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    const reload = vi.fn()
    render(<ModelVisibilitySection state={withHidden({})} api={api} t={t} reload={reload} />)
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    await waitFor(() => { expect(reload).toHaveBeenCalledTimes(1) })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'ui-model-selection',
      ops: [{ op: 'set', path: ['hiddenModels', 'deepseek-official'], value: ['deepseek-v4-pro'] }],
      expectedRevision: 3,
    })
  })

  it('re-checking the last hidden model in a provider unsets the whole key', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    const reload = vi.fn()
    render(
      <ModelVisibilitySection
        state={withHidden({ 'deepseek-official': ['deepseek-v4-pro'] })}
        api={api}
        t={t}
        reload={reload}
      />,
    )
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    await waitFor(() => { expect(reload).toHaveBeenCalledTimes(1) })
    expect(mutate).toHaveBeenCalledWith({
      ns: 'ui-model-selection',
      ops: [{ op: 'unset', path: ['hiddenModels', 'deepseek-official'] }],
      expectedRevision: 3,
    })
  })

  it('hide-all hides every model in the group; show-all then restores them', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    render(<ModelVisibilitySection state={withHidden({})} api={api} t={t} reload={vi.fn()} />)
    fireEvent.click(screen.getByText(en.hideAll))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'ui-model-selection',
        ops: [{ op: 'set', path: ['hiddenModels', 'deepseek-official'], value: ['deepseek-v4-flash', 'deepseek-v4-pro'] }],
        expectedRevision: 3,
      })
    })
  })

  it('shows Show all once every model in the group is hidden, and clicking it unhides them all', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    render(
      <ModelVisibilitySection
        state={withHidden({ 'deepseek-official': ['deepseek-v4-flash', 'deepseek-v4-pro'] })}
        api={api}
        t={t}
        reload={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText(en.showAll))
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: 'ui-model-selection',
        ops: [{ op: 'unset', path: ['hiddenModels', 'deepseek-official'] }],
        expectedRevision: 3,
      })
    })
  })

  it('a settings-conflict reports the conflict copy and still reloads', async () => {
    const mutate = vi.fn(() => Promise.resolve(fail('settings-conflict', 'stale revision')))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    const reload = vi.fn()
    render(<ModelVisibilitySection state={withHidden({})} api={api} t={t} reload={reload} />)
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    await waitFor(() => { expect(screen.getByText(en.visibilityConflict)).toBeTruthy() })
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a non-conflict business failure shows the wire message', async () => {
    const mutate = vi.fn(() => Promise.resolve(fail('internal', 'settings document is read-only')))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    render(<ModelVisibilitySection state={withHidden({})} api={api} t={t} reload={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    await waitFor(() => { expect(screen.getByText('settings document is read-only')).toBeTruthy() })
  })

  it('a transport rejection is stringified into the failure text', async () => {
    const mutate = vi.fn(() => Promise.reject(new Error('connection lost')))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    render(<ModelVisibilitySection state={withHidden({})} api={api} t={t} reload={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    await waitFor(() => { expect(screen.getByText('connection lost')).toBeTruthy() })
  })

  it('keeps checkboxes enabled while a write is pending so further toggles queue behind it', async () => {
    let settle: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { settle = resolve })
    const mutate = vi.fn(async () => { await gate; return ok({}) })
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    render(<ModelVisibilitySection state={withHidden({})} api={api} t={t} reload={vi.fn()} />)
    const pro = screen.getByLabelText('DeepSeek-V4-Pro') as HTMLInputElement
    fireEvent.click(pro)
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    expect(pro.disabled).toBe(false)
    settle?.()
  })

  it('drops toggles queued behind a failed write and reports the failure', async () => {
    let releaseFirst: (value: RpcResponse<unknown>) => void = () => {}
    const mutate = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    const reload = vi.fn()
    render(<ModelVisibilitySection state={withHidden({})} api={api} t={t} reload={reload} />)
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Flash'))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    releaseFirst(fail('settings-conflict', 'stale'))
    await waitFor(() => { expect(reload).toHaveBeenCalledTimes(1) })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(screen.getByText(en.visibilityConflict)).toBeTruthy()
  })

  it('disables every checkbox when the settings document is read-only', () => {
    render(<ModelVisibilitySection state={state({ writable: false })} api={{} as never} t={t} reload={vi.fn()} />)
    expect(screen.getByLabelText<HTMLInputElement>('DeepSeek-V4-Flash').disabled).toBe(true)
  })
})

describe('writeHiddenModels', () => {
  it('omits expectedRevision when no revision is known', async () => {
    const mutate = vi.fn(() => Promise.resolve(ok({})))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    const result = await writeHiddenModels(api, undefined, 'deepseek-official', ['deepseek-v4-pro'], t)
    expect(result.ok).toBe(true)
    expect(mutate).toHaveBeenCalledWith({
      ns: 'ui-model-selection',
      ops: [{ op: 'set', path: ['hiddenModels', 'deepseek-official'], value: ['deepseek-v4-pro'] }],
    })
  })
})

describe('ModelVisibilitySection rapid successive toggles', () => {
  const TWO_GROUPS: ModelProviderGroup[] = [
    ...GROUPS,
    { id: 'antigravity', name: 'Antigravity', models: [{ id: 'gemini-low', name: 'Gemini Low' }] },
  ]

  function view(hidden: Record<string, string[]>, revision: number) {
    return {
      ns: 'ui-model-selection', schema: {}, value: { hiddenModels: hidden },
      applies: 'live' as const, secrets: [], revision,
    }
  }

  it('serializes writes so a second toggle carries the revision and list the first write returned', async () => {
    let releaseFirst: (value: RpcResponse<unknown>) => void = () => {}
    const mutate = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
      .mockImplementationOnce(() => Promise.resolve(ok(view({ 'deepseek-official': ['deepseek-v4-pro'], antigravity: ['gemini-low'] }, 5))))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    const reload = vi.fn()
    render(
      <ModelVisibilitySection
        state={{ ...withHidden({}, 3), catalogGroups: TWO_GROUPS }}
        api={api}
        t={t}
        reload={reload}
      />,
    )
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    fireEvent.click(screen.getByLabelText('Gemini Low'))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(mutate).toHaveBeenCalledTimes(1)
    releaseFirst(ok(view({ 'deepseek-official': ['deepseek-v4-pro'] }, 4)))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    expect(mutate).toHaveBeenLastCalledWith({
      ns: 'ui-model-selection',
      ops: [{ op: 'set', path: ['hiddenModels', 'antigravity'], value: ['gemini-low'] }],
      expectedRevision: 4,
    })
    await waitFor(() => { expect(reload).toHaveBeenCalledTimes(1) })
    expect(screen.queryByText(en.visibilityConflict)).toBeNull()
    expect(screen.getByLabelText<HTMLInputElement>('DeepSeek-V4-Pro').checked).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>('Gemini Low').checked).toBe(false)
  })

  it('accumulates two toggles in one provider instead of dropping the second', async () => {
    let releaseFirst: (value: RpcResponse<unknown>) => void = () => {}
    const mutate = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
      .mockImplementationOnce(() => Promise.resolve(ok(view({ 'deepseek-official': ['deepseek-v4-pro', 'deepseek-v4-flash'] }, 5))))
    const api = { settings: { mutate } } as unknown as Pick<IApiClient, 'settings'>
    render(<ModelVisibilitySection state={withHidden({}, 3)} api={api} t={t} reload={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Pro'))
    fireEvent.click(screen.getByLabelText('DeepSeek-V4-Flash'))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(1) })
    releaseFirst(ok(view({ 'deepseek-official': ['deepseek-v4-pro'] }, 4)))
    await waitFor(() => { expect(mutate).toHaveBeenCalledTimes(2) })
    expect(mutate).toHaveBeenLastCalledWith({
      ns: 'ui-model-selection',
      ops: [{ op: 'set', path: ['hiddenModels', 'deepseek-official'], value: ['deepseek-v4-pro', 'deepseek-v4-flash'] }],
      expectedRevision: 4,
    })
  })
})
