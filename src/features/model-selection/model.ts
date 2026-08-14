import type {
  ModelProviderGroup,
  ModelReasoningEffort,
  ModelSelection,
  SessionId,
  SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ModelSelectionController,
  ModelSelectionControllerOptions,
  ModelSelectionEntry,
  ModelSelectionPane,
  ModelSelectionRowView,
  ModelSelectionSnapshotView,
} from './contracts.js'
import { sanitizeText } from '../sessions/projection.js'

export type * from './contracts.js'

const OVERLAY_ID = 'model-selection'
const SELECT_MODEL_COPY = 'Select model'
const MODEL_ROW_TITLE = 'Model'
const EFFORT_ROW_TITLE = 'Effort'
const PROVIDER_DEFAULT_COPY = 'Provider default'
const READY_STATUS = 'Choose model or reasoning effort.'
const LOADING_STATUS = 'Loading model catalog…'
const SELECTING_STATUS = 'Selecting model…'
const UNROUTABLE_STATUS = 'No provider can route the current model.'
const EMPTY_STATUS = 'No models advertised. Configure a provider.'
const CLOSED_STATUS = 'Model picker closed.'
const FIRST_INDEX = 0

type DirectoryStatus = 'error' | 'idle' | 'loading' | 'ready' | 'selecting'

interface DirectoryState {
  current: ModelSelection | null
  error: string | undefined
  failures: SessionModels['failures']
  generation: number
  groups: SessionModels['groups']
  routable: boolean | undefined
  status: DirectoryStatus
}

type ModelDefinition = ModelProviderGroup['models'][number]

type RowTarget =
  | { readonly kind: 'effort'; readonly effort: string | undefined }
  | { readonly kind: 'model'; readonly group: ModelProviderGroup; readonly model: ModelDefinition }
  | { readonly kind: 'pane'; readonly pane: Exclude<ModelSelectionPane, 'root'> }
  | { readonly kind: 'unavailable' }

interface Projection {
  readonly rows: readonly ModelSelectionRowView[]
  readonly targets: readonly RowTarget[]
}

function emptyDirectory(): DirectoryState {
  return {
    current: null,
    error: undefined,
    failures: [],
    generation: 0,
    groups: [],
    routable: undefined,
    status: 'idle',
  }
}

function selectedModel(state: DirectoryState): {
  readonly group: ModelProviderGroup
  readonly model: ModelDefinition
} | undefined {
  if (state.current === null) return undefined
  for (const group of state.groups) {
    const model = group.models.find(candidate => candidate.id === state.current?.model)
    if (group.id === state.current.provider && model !== undefined) return { group, model }
  }
  return undefined
}

function effortLabel(reasoning: ModelDefinition['reasoning'], effort: string | undefined): string | undefined {
  if (reasoning === undefined) return undefined
  if (effort === undefined) return PROVIDER_DEFAULT_COPY
  return sanitizeText(reasoning.efforts.find(candidate => candidate.id === effort)?.name ?? effort)
}

function rootProjection(state: DirectoryState): Projection {
  const selected = selectedModel(state)
  const rows: ModelSelectionRowView[] = [{
    details: selected === undefined ? SELECT_MODEL_COPY : sanitizeText(selected.model.name),
    enabled: true,
    id: 'model-selection-root-model',
    selected: false,
    title: MODEL_ROW_TITLE,
  }]
  const targets: RowTarget[] = [{ kind: 'pane', pane: 'model' }]
  if (selected?.model.reasoning !== undefined) {
    const currentEffort = state.current?.reasoningEffort ?? selected.model.reasoning.defaultEffort
    rows.push({
      details: effortLabel(selected.model.reasoning, currentEffort) ?? PROVIDER_DEFAULT_COPY,
      enabled: true,
      id: 'model-selection-root-effort',
      selected: false,
      title: EFFORT_ROW_TITLE,
    })
    targets.push({ kind: 'pane', pane: 'effort' })
  }
  return { rows, targets }
}

function modelProjection(state: DirectoryState): Projection {
  const rows: ModelSelectionRowView[] = []
  const targets: RowTarget[] = []
  for (const group of state.groups) {
    for (const model of group.models) {
      const selected = state.current?.provider === group.id && state.current.model === model.id
      rows.push({
        details: sanitizeText([group.name, model.description].filter(part => part !== undefined).join(' · ')),
        enabled: true,
        id: `model-selection-model-${rows.length}`,
        selected,
        title: sanitizeText(model.name),
      })
      targets.push({ kind: 'model', group, model })
    }
  }
  for (const failure of state.failures) {
    rows.push({
      details: sanitizeText(failure.message),
      enabled: false,
      id: `model-selection-failure-${rows.length}`,
      selected: false,
      title: sanitizeText(failure.name),
    })
    targets.push({ kind: 'unavailable' })
  }
  return { rows, targets }
}

function effortProjection(state: DirectoryState): Projection {
  const selected = selectedModel(state)
  const reasoning = selected?.model.reasoning
  if (reasoning === undefined) return { rows: [], targets: [] }
  const currentEffort = state.current?.reasoningEffort ?? reasoning.defaultEffort
  const efforts: Array<ModelReasoningEffort | undefined> = reasoning.defaultEffort === undefined
    ? [undefined, ...reasoning.efforts]
    : [...reasoning.efforts]
  return {
    rows: efforts.map((effort, index) => ({
      details: sanitizeText(effort?.description ?? (effort === undefined ? PROVIDER_DEFAULT_COPY : effort.id)),
      enabled: true,
      id: `model-selection-effort-${index}`,
      selected: effort?.id === currentEffort,
      title: sanitizeText(effort?.name ?? PROVIDER_DEFAULT_COPY),
    })),
    targets: efforts.map(effort => ({ kind: 'effort', effort: effort?.id })),
  }
}

function project(state: DirectoryState, pane: ModelSelectionPane): Projection {
  switch (pane) {
    case 'root': return rootProjection(state)
    case 'model': return modelProjection(state)
    case 'effort': return effortProjection(state)
    default: {
      const exhaustive: never = pane
      return exhaustive
    }
  }
}

function statusOf(state: DirectoryState, active: boolean): string {
  if (!active) return CLOSED_STATUS
  if (state.routable === false) return UNROUTABLE_STATUS
  if (state.status === 'loading') return LOADING_STATUS
  if (state.status === 'selecting') return SELECTING_STATUS
  if (state.error !== undefined) return state.error
  if (state.groups.every(group => group.models.length === 0)) return EMPTY_STATUS
  return READY_STATUS
}

class ModelSelectionControllerService implements ModelSelectionController {
  private readonly availableFor: ModelSelectionControllerOptions['available']
  private readonly directories = new Map<SessionId, DirectoryState>()
  private readonly list: ModelSelectionControllerOptions['list']
  private readonly listeners = new Set<() => void>()
  private readonly navigation: ModelSelectionControllerOptions['navigation']
  private readonly openProviderSettings: ModelSelectionControllerOptions['openProviders']
  private readonly port: ModelSelectionControllerOptions['port']
  private readonly resources: Array<() => void>
  private boundSessionId: SessionId | undefined
  private disposed = false
  private entry: ModelSelectionEntry | undefined
  private pane: ModelSelectionPane = 'root'
  private rowIndex = FIRST_INDEX

  constructor(options: ModelSelectionControllerOptions) {
    this.availableFor = options.available
    this.list = options.list
    this.navigation = options.navigation
    this.openProviderSettings = options.openProviders
    this.port = options.port
    this.resources = [options.list.subscribe(() => { this.rebind() })]
    this.rebind(false)
  }

  activate(): Promise<boolean> {
    if (!this.active() || this.busy()) return Promise.resolve(false)
    const state = this.state()
    const target = project(state, this.pane).targets[this.rowIndex]
    if (target === undefined || target.kind === 'unavailable') return Promise.resolve(false)
    switch (target.kind) {
      case 'pane':
        this.pane = target.pane
        this.rowIndex = FIRST_INDEX
        this.publish()
        return Promise.resolve(true)
      case 'model': return this.selectModel(target.group, target.model)
      case 'effort': return this.selectEffort(target.effort)
      default: {
        const exhaustive: never = target
        return exhaustive
      }
    }
  }

  back(): void {
    if (!this.active()) return
    if (this.entry === 'composer' && this.pane !== 'root') {
      this.pane = 'root'
      this.rowIndex = FIRST_INDEX
      this.publish()
      return
    }
    this.close()
  }

  close(): void {
    this.navigation.dismissOverlay(OVERLAY_ID)
    this.entry = undefined
    this.pane = 'root'
    this.rowIndex = FIRST_INDEX
    this.publish()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.navigation.dismissOverlay(OVERLAY_ID)
    for (const state of this.directories.values()) state.generation++
    this.directories.clear()
    for (const dispose of this.resources.splice(0).toReversed()) dispose()
    this.listeners.clear()
  }

  getSnapshot(): ModelSelectionSnapshotView {
    const state = this.state()
    const selected = selectedModel(state)
    const currentEffort = state.current?.reasoningEffort ?? selected?.model.reasoning?.defaultEffort
    const active = this.active()
    const projection = project(state, this.pane)
    return Object.freeze({
      active,
      available: this.available(),
      blocked: state.routable === false,
      busy: this.busy(),
      currentLabel: selected === undefined ? SELECT_MODEL_COPY : sanitizeText(selected.model.name),
      effortLabel: effortLabel(selected?.model.reasoning, currentEffort),
      entry: this.entry,
      error: state.error,
      overlayId: active ? OVERLAY_ID : undefined,
      pane: this.pane,
      routable: state.routable,
      rowIndex: Math.min(this.rowIndex, Math.max(FIRST_INDEX, projection.rows.length - 1)),
      rows: Object.freeze(projection.rows),
      status: statusOf(state, active),
    })
  }

  move(delta: number): void {
    const count = project(this.state(), this.pane).rows.length
    if (!this.active() || this.busy() || count === 0 || !Number.isFinite(delta) || delta === 0) return
    const direction = delta < 0 ? -1 : 1
    this.rowIndex = (this.rowIndex + direction + count) % count
    this.publish()
  }

  async open(entry: ModelSelectionEntry): Promise<boolean> {
    if (!this.available()) return false
    this.entry = entry
    this.pane = entry === 'command' ? 'model' : 'root'
    this.rowIndex = FIRST_INDEX
    if (!this.navigation.getSnapshot().overlays.some(overlay => overlay.id === OVERLAY_ID)) {
      this.navigation.openOverlay({ id: OVERLAY_ID })
    }
    this.publish()
    await this.refresh()
    return true
  }

  openProviders(): void {
    this.close()
    this.openProviderSettings()
  }

  async refresh(): Promise<void> {
    const sessionId = this.boundSessionId
    if (sessionId === undefined || !this.availableFor(sessionId)) return
    const state = this.directory(sessionId)
    const generation = ++state.generation
    state.status = 'loading'
    state.error = undefined
    this.publish()
    const result = await this.port.models(sessionId)
    if (this.disposed || state.generation !== generation) return
    if (!result.ok) {
      state.status = 'error'
      state.error = sanitizeText(`${result.error.code}: ${result.error.message}`)
      this.publish()
      return
    }
    state.current = result.value.current
    state.routable = result.value.routable
    state.groups = result.value.groups
    state.failures = result.value.failures
    state.status = 'ready'
    state.error = undefined
    this.reconcileRow()
    this.publish()
  }

  selectRow(index: number): void {
    const count = project(this.state(), this.pane).rows.length
    if (!this.active() || this.busy() || !Number.isSafeInteger(index) || index < 0 || index >= count) return
    this.rowIndex = index
    this.publish()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private active(): boolean {
    return this.entry !== undefined
      && this.navigation.getSnapshot().overlays.at(-1)?.id === OVERLAY_ID
  }

  private available(): boolean {
    return this.boundSessionId !== undefined && this.availableFor(this.boundSessionId)
  }

  private busy(): boolean {
    const status = this.state().status
    return status === 'loading' || status === 'selecting'
  }

  private directory(sessionId: SessionId): DirectoryState {
    let state = this.directories.get(sessionId)
    if (state === undefined) {
      state = emptyDirectory()
      this.directories.set(sessionId, state)
    }
    return state
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }

  private rebind(publish = true): void {
    const list = this.list.getSnapshot()
    for (const [sessionId, state] of this.directories) {
      if (list.byId[sessionId] !== undefined) continue
      state.generation++
      this.directories.delete(sessionId)
    }
    if (this.boundSessionId === list.current) {
      if (publish) this.publish()
      return
    }
    this.navigation.dismissOverlay(OVERLAY_ID)
    this.entry = undefined
    this.pane = 'root'
    this.rowIndex = FIRST_INDEX
    this.boundSessionId = list.current
    if (publish) this.publish()
    if (this.available()) void this.refresh()
  }

  private reconcileRow(): void {
    const count = project(this.state(), this.pane).rows.length
    this.rowIndex = Math.min(this.rowIndex, Math.max(FIRST_INDEX, count - 1))
  }

  private async select(selection: ModelSelection): Promise<boolean> {
    const sessionId = this.boundSessionId
    if (sessionId === undefined || !this.availableFor(sessionId)) return false
    const state = this.directory(sessionId)
    const generation = ++state.generation
    state.status = 'selecting'
    state.error = undefined
    this.publish()
    const result = await this.port.select(sessionId, selection)
    if (this.disposed || state.generation !== generation) return false
    if (!result.ok) {
      state.status = 'error'
      state.error = sanitizeText(`${result.error.code}: ${result.error.message}`)
      this.publish()
      return false
    }
    state.current = result.value
    state.routable = true
    state.status = 'ready'
    state.error = undefined
    this.close()
    return true
  }

  private selectEffort(effort: string | undefined): Promise<boolean> {
    const current = this.state().current
    if (current === null) return Promise.resolve(false)
    return this.select({
      provider: current.provider,
      model: current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    })
  }

  private selectModel(group: ModelProviderGroup, model: ModelDefinition): Promise<boolean> {
    const current = this.state().current
    const sameRoute = current?.provider === group.id && current.model === model.id
    const reasoningEffort = sameRoute
      ? current.reasoningEffort ?? model.reasoning?.defaultEffort
      : model.reasoning?.defaultEffort
    return this.select({
      provider: group.id,
      model: model.id,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  private state(): DirectoryState {
    return this.boundSessionId === undefined ? emptyDirectory() : this.directory(this.boundSessionId)
  }
}

export function createModelSelectionController(
  options: ModelSelectionControllerOptions,
): ModelSelectionController {
  return new ModelSelectionControllerService(options)
}
