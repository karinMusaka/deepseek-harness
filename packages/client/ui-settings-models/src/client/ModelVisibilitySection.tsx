/**
 * Model-picker visibility section: one checkbox per model across every
 * provider group the unfiltered Host catalog (`llm.models`) reports, plus a
 * per-provider show-all/hide-all control. Unchecking a model writes its id
 * into `ui-model-selection.hiddenModels.<provider>` — the durable preference
 * `ModelDirectory` (that package's own browser half) filters the picker
 * against. This section only edits the preference: it never touches a
 * session's selection or the provider rows above it.
 */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { HIDDEN_MODELS_FIELD, hiddenModelsOf, MODEL_VISIBILITY_NS, messageOf } from './store.ts'
import type { ModelsSettingsState } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Outcome of one {@link writeHiddenModels} call. */
export type HiddenModelsWrite =
  | { readonly ok: true; readonly view: SettingsNamespaceView }
  | { readonly ok: false; readonly message: string }

/**
 * Write the durable hidden-model list for one provider. `unset` clears the
 * whole key once nothing is hidden — the default, unhidden state needs no
 * stored override — otherwise `set` replaces it. Carries the namespace's
 * current revision so a concurrent editor is refused as `settings-conflict`.
 * @param api - settings wire face.
 * @param revision - the namespace's last known revision; omitted carries no fence.
 * @param provider - provider route id being edited.
 * @param hidden - the complete next hidden-model id list for this provider.
 * @param t - section copy, for the conflict message.
 * @returns the namespace view the write committed, or the failure message.
 */
export async function writeHiddenModels(
  api: Pick<IApiClient, 'settings'>,
  revision: number | undefined,
  provider: string,
  hidden: readonly string[],
  t: (key: keyof typeof en) => string,
): Promise<HiddenModelsWrite> {
  const path = [HIDDEN_MODELS_FIELD, provider]
  try {
    const response = await api.settings.mutate({
      ns: MODEL_VISIBILITY_NS,
      ops: [hidden.length === 0 ? { op: 'unset', path } : { op: 'set', path, value: [...hidden] }],
      ...revision === undefined ? {} : { expectedRevision: revision },
    })
    if (!response.result.ok) {
      const { error } = response.result
      return { ok: false, message: error.code === 'settings-conflict' ? t('visibilityConflict') : error.message }
    }
    return { ok: true, view: response.result.value }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}

/** A namespace map holding at most the visibility view, the shape `hiddenModelsOf` reads. */
function viewMap(view: SettingsNamespaceView | undefined): ReadonlyMap<string, SettingsNamespaceView> {
  return new Map(view === undefined ? [] : [[MODEL_VISIBILITY_NS, view]])
}

/** The newer of two views of the visibility namespace, by revision. */
function newerView(
  a: SettingsNamespaceView | undefined,
  b: SettingsNamespaceView | undefined,
): SettingsNamespaceView | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return b.revision > a.revision ? b : a
}

/** Props of {@link ModelVisibilitySection}. */
export interface ModelVisibilitySectionProps {
  /** The shared page snapshot (catalog, namespaces, writable). */
  state: ModelsSettingsState
  /** Wire face the section writes through. */
  api: Pick<IApiClient, 'settings'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Refresh the shared page snapshot after a write settles. */
  reload: () => void
}

/**
 * Render the model-picker visibility section.
 * @param props - the shared page snapshot, wire face, copy, and reload callback.
 * @returns the section, or null while the catalog has nothing to list yet.
 */
export function ModelVisibilitySection({ state, api, t, reload }: ModelVisibilitySectionProps): ReactNode {
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // The view the last committed write returned. Clicks can outpace the page
  // reload, so each queued write reads the newest known view at the time it
  // runs: its revision fences the write and its list is the base the toggle
  // applies to.
  const [written, setWritten] = useState<SettingsNamespaceView | undefined>(undefined)
  const latest = useRef<SettingsNamespaceView | undefined>(undefined)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const inFlight = useRef(0)
  // A failed write discards the toggles queued behind it: they were computed
  // against a view the failure just proved stale.
  const generation = useRef(0)

  const namespace = newerView(state.namespaces.get(MODEL_VISIBILITY_NS), written)
  latest.current = newerView(latest.current, namespace)

  if (state.catalogGroups.length === 0 && state.catalogError === null) return null

  const commit = (provider: string, next: (hidden: readonly string[]) => readonly string[]): void => {
    setFailure(undefined)
    const enqueued = generation.current
    inFlight.current += 1
    queue.current = queue.current.then(async () => {
      if (enqueued !== generation.current) return
      const view = latest.current
      const hidden = hiddenModelsOf(viewMap(view), provider)
      const result = await writeHiddenModels(api, view?.revision, provider, next(hidden), t)
      if (result.ok) {
        latest.current = result.view
        setWritten(result.view)
      } else {
        generation.current += 1
        setFailure(result.message)
      }
    }).finally(() => {
      inFlight.current -= 1
      if (inFlight.current === 0) reload()
    })
  }

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('visibilityTitle')}</h2>
      <p className={styles['intro']}>{t('visibilityIntro')}</p>
      {namespace === undefined ? <p className={styles['notice']}>{t('visibilityUnavailable')}</p> : null}
      {state.catalogError !== null
        ? <p className={styles['error']}>{`${t('visibilityLoadFailed')}: ${state.catalogError}`}</p>
        : null}
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      <div className={styles['visibilityGroups']}>
        {state.catalogGroups.map((group) => {
          const hidden = hiddenModelsOf(viewMap(namespace), group.id)
          const allHidden = group.models.every(model => hidden.includes(model.id))
          const disabled = !state.writable || namespace === undefined
          return (
            <div key={group.id} className={styles['visibilityGroup']}>
              <div className={styles['visibilityGroupHead']}>
                <span className={styles['visibilityGroupName']}>{group.name}</span>
                <button
                  type="button"
                  className={styles['linkButton']}
                  disabled={disabled}
                  onClick={() => { commit(group.id, () => (allHidden ? [] : group.models.map(model => model.id))) }}
                >
                  {allHidden ? t('showAll') : t('hideAll')}
                </button>
              </div>
              <ul className={styles['visibilityList']}>
                {group.models.map((model) => {
                  const modelHidden = hidden.includes(model.id)
                  return (
                    <li key={model.id}>
                      <label className={styles['candidateLabel']}>
                        <input
                          type="checkbox"
                          checked={!modelHidden}
                          disabled={disabled}
                          onChange={() => {
                            commit(
                              group.id,
                              current => (modelHidden
                                ? current.filter(id => id !== model.id)
                                : [...current.filter(id => id !== model.id), model.id]),
                            )
                          }}
                        />
                        <span className={styles['candidateId']}>{model.name}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
      {state.catalogFailures.map(failureRow => (
        <p key={failureRow.id} className={styles['advancedHint']}>
          {`${failureRow.name}: ${failureRow.message}`}
        </p>
      ))}
    </div>
  )
}
