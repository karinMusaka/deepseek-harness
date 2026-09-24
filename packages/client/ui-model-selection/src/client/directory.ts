/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and the composer-seat selector load through the same
 * controller and submit through the same selectModel call, so the host stays
 * the single fact source and the store is one shared echo — a switch made in
 * either entry is what the other shows next.
 */
import type {
  IApiClient, ModelCatalogFailure, ModelProviderGroup, ModelSelection, SessionId, SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelVisibilitySettings } from '../model-visibility-settings.ts'
import { filterGroups, type HiddenModels } from './visibility.ts'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Model selection the host reports for the next assembled step; null before the first load. */
  current: ModelSelection | null
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /**
   * Successfully loaded provider groups (last good load), with the user's
   * hidden models already removed (`ModelDirectory`'s own filter — the sole
   * enforcement point) except for the exact current provider/model pair,
   * which is never hidden. `session.selectModel` itself is unfiltered: a
   * hidden-but-current model keeps routing normally.
   */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
  })

  /** Latest operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false

  /** Raw (unfiltered) groups from the last good load; the filtering input `refilter` recomputes from. */
  private rawGroups: readonly ModelProviderGroup[] = []

  private readonly unsubscribeHidden: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param hidden - the shared (per-connection, not per-session) hidden-model
   * preference scope. Its own `getSnapshot().status` decides fail-open: not
   * `ready` (loading, unavailable, or memory-mode) hides nothing.
   */
  constructor(
    private readonly sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly hidden: Pick<SettingsScope<ModelVisibilitySettings>, 'getSnapshot' | 'subscribe'>,
  ) {
    // A hidden-set change refilters the last good load in place — no network
    // round trip — so toggling a preference is visible immediately regardless
    // of how the resolver's own broader `settings/document-updated` reload
    // happens to race against this scope's independent refresh.
    this.unsubscribeHidden = hidden.subscribe(() => { this.refilter() })
  }

  /** The live hidden-model preference, or none while it is not a ready durable section. */
  private hiddenModels(): HiddenModels {
    const snapshot = this.hidden.getSnapshot()
    return snapshot.status === 'ready' ? snapshot.value?.hiddenModels ?? {} : {}
  }

  /** Recompute `groups` from the last good raw load without touching the network. */
  private refilter(): void {
    if (this.disposed) return
    this.store.update((s) => { s.groups = filterGroups(this.rawGroups, this.hiddenModels(), s.current) })
  }

  /**
   * Refresh the advisory directory (both entries call this on open).
   * Failure preserves the last good groups and current selection.
   * @returns the fresh directory value.
   */
  async load(): Promise<SessionModels> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    const { result } = await this.sessions.models({ sessionId: this.sessionId })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      // Superseded by a newer load: this call's raw groups never become the
      // shared rawGroups, but its own caller still awaits a filtered result.
      const { current, routable, groups, failures } = result.value
      return { current, routable, groups: filterGroups(groups, this.hiddenModels(), current), failures }
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`)
    }
    const { current, routable, groups, failures } = result.value
    this.rawGroups = groups
    const shown = filterGroups(groups, this.hiddenModels(), current)
    this.store.update((s) => {
      s.current = current
      s.routable = routable
      s.groups = shown
      s.failures = failures
      s.status = 'ready'
      s.error = null
    })
    return { current, routable, groups: shown, failures }
  }

  /**
   * Select the complete provider/model/reasoning selection (both entries submit through here). Success
   * updates the shared current; failure surfaces on the store and throws so
   * each entry's own retry surface engages.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
 */
  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.error = null })
    const { result } = await this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    })
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
    }
    // The Host validated the route before accepting it, so a selection that
    // landed is by construction one it can serve. Groups are re-derived: the
    // newly current pair is exempted from hiding even if it was hidden, and
    // the previously current pair becomes hideable again.
    this.store.update((s) => {
      s.current = result.value.selected
      s.routable = true
      s.groups = filterGroups(this.rawGroups, this.hiddenModels(), result.value.selected)
      s.status = 'ready'
      s.error = null
    })
  }

  /**
   * Drop the previous Host generation's projection and repull it. Clearing
   * first prevents an unconsumed process-local selection from being displayed
   * while the restarted Host has restored the last logged model selection.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.rawGroups = []
    this.store.update((s) => {
      s.current = null
      s.routable = null
      s.groups = []
      s.failures = []
      s.status = 'idle'
      s.error = null
    })
    if (!this.available()) return
    void this.load().catch(() => { /* the next menu open remains the explicit retry surface */ })
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeHidden()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }
}
