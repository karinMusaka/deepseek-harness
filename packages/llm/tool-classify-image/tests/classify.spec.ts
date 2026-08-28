/**
 * `classify_image` over the REAL local filesystem, the real attachment
 * validation helpers, and the real tool registry, with only the model route
 * scripted: route refusal, path and admission refusals, the log-only
 * pre-dispatch record, the ephemeral image message the calling session never
 * sees, and every terminal finish reason.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { readImageFile, saveImageFile, validateImageFile } from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmResolvedModelInfo,
  ModelModality,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolClassifyImage from '../src/index.ts'
import { CLASSIFY_IMAGE_PROMPTS, imageMediaTypeForPath } from '../src/classify.ts'
import { resolveClassifyImagePolicy } from '../src/index.ts'

/** 1x1 red PNG (valid signature, IHDR, IDAT, IEND). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
)
/** 3x3 red PNG, used to exceed a deliberately tiny pixel limit. */
const PNG_3X3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==',
  'base64',
)

const ALL_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Test attachment store: real byte validation from `dsh-attachment-local`, test-chosen limits. */
class TestAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits
  private readonly root: string

  constructor(ctx: Context, config: { root: string; mediaTypes?: readonly ImageMediaType[]; maxImagePixels?: number }) {
    super(ctx)
    this.root = config.root
    this.imageLimits = Object.freeze({
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: config.maxImagePixels ?? 1_000_000,
      mediaTypes: Object.freeze([...config.mediaTypes ?? ALL_MEDIA_TYPES]),
    })
  }

  validateImage(input: SaveImageAttachment): Promise<void> {
    return validateImageFile(input, this.imageLimits)
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return saveImageFile(this.root, input, this.imageLimits)
  }

  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }
}

/** One scripted model answer: a sentence, an explicit terminal reason, or an adapter throw. */
type Answer = string | { finish: FinishReason } | { throws: string }

/** Scripted vision route: each `stream` call consumes the next answer and records the request. */
class ScriptedVisionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  answers: Answer[] = []
  modalities: ModelModality[] | undefined = ['text', 'image']

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.modalities === undefined ? {} : { inputModalities: [...this.modalities] },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const answer = this.answers.shift()
    if (answer === undefined) throw new Error('vision script exhausted')
    if (typeof answer === 'object' && 'throws' in answer) throw new Error(answer.throws)
    if (typeof answer === 'object') {
      yield { type: 'finish', reason: answer.finish }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let dir: string
let store: string
let context: Context | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-classify-image-'))
  store = await mkdtemp(join(tmpdir(), 'dsh-classify-image-store-'))
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await rm(dir, { recursive: true, force: true })
  await rm(store, { recursive: true, force: true })
})

interface SetupOptions {
  mediaTypes?: readonly ImageMediaType[]
  maxImagePixels?: number
  config?: ToolClassifyImage.Config
}

async function setup(options: SetupOptions = {}): Promise<{
  ctx: Context
  adapter: ScriptedVisionAdapter
  toolFiber: { dispose(): Promise<void> }
}> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(TestAttachmentStore, {
    root: join(store, 'attachments', 'v1'),
    ...options.mediaTypes === undefined ? {} : { mediaTypes: options.mediaTypes },
    ...options.maxImagePixels === undefined ? {} : { maxImagePixels: options.maxImagePixels },
  })
  await ctx.plugin(LlmRuntime)
  const adapter = new ScriptedVisionAdapter()
  ctx.llm.registerAdapter(['ollama'], adapter)
  const toolFiber = await ctx.plugin(ToolClassifyImage, options.config ?? {})
  return { ctx, adapter, toolFiber }
}

/** A calling agent whose real session records the pre-dispatch event. */
function agentWith(session: Session): object {
  return { id: session.id, options: {}, session }
}

/** A session whose header carries the workspace cwd, so relative paths resolve there. */
function sessionInWorkspace(id: string): Session {
  const sessionId = SessionId(id)
  const header: SessionHeader = { version: 0, id: sessionId, createdAt: Date.now(), cwd: dir }
  return Session.create(sessionId, undefined, header)
}

let callCounter = 0
function classify(ctx: Context, args: unknown, agent?: object) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`classify-${++callCounter}`),
    name: 'classify_image',
    arguments: args,
    ...agent === undefined ? {} : { agent: agent as never },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function writeImage(name: string, bytes: Buffer): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

describe('imageMediaTypeForPath', () => {
  it('maps the five accepted extensions case-insensitively and rejects everything else', () => {
    expect(imageMediaTypeForPath('a.png')).toBe('image/png')
    expect(imageMediaTypeForPath('a.JPG')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('b.jpeg')).toBe('image/jpeg')
    expect(imageMediaTypeForPath('c.webp')).toBe('image/webp')
    expect(imageMediaTypeForPath('d.Gif')).toBe('image/gif')
    expect(imageMediaTypeForPath('note.txt')).toBeUndefined()
  })
})

describe('resolveClassifyImagePolicy', () => {
  it('applies the verified local vision route and bounds when nothing is configured', () => {
    expect(resolveClassifyImagePolicy({})).toEqual({
      provider: 'ollama',
      model: 'minicpm-v:latest',
      maxTokens: 128,
      timeoutMs: 120_000,
    })
  })

  it('accepts an explicit route and bounds', () => {
    expect(resolveClassifyImagePolicy({ provider: 'p', model: 'm', maxTokens: 32, timeoutMs: 5000 })).toEqual({
      provider: 'p',
      model: 'm',
      maxTokens: 32,
      timeoutMs: 5000,
    })
  })

  it.each([
    { label: 'an unknown key', config: { nope: 1 }, failure: 'unknown config key "nope"' },
    { label: 'a provider without a model', config: { provider: 'p' }, failure: 'provider and model must be supplied together' },
    { label: 'a model without a provider', config: { model: 'm' }, failure: 'provider and model must be supplied together' },
    { label: 'an empty provider', config: { provider: '', model: 'm' }, failure: 'must be non-empty strings' },
    { label: 'an empty model', config: { provider: 'p', model: '' }, failure: 'must be non-empty strings' },
    { label: 'a fractional maxTokens', config: { maxTokens: 1.5 }, failure: 'maxTokens must be a positive integer' },
    { label: 'a zero timeoutMs', config: { timeoutMs: 0 }, failure: 'timeoutMs must be a positive integer' },
  ])('rejects $label', ({ config, failure }) => {
    expect(() => resolveClassifyImagePolicy(config as ToolClassifyImage.Config)).toThrow(failure)
  })
})

describe('classify_image route gate', () => {
  it('refuses before any filesystem work when the route declares no modalities', async () => {
    const { ctx, adapter } = await setup()
    adapter.modalities = undefined
    const path = await writeImage('a.png', PNG_1X1)

    const result = await classify(ctx, { path })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('does not declare image input')
    expect(adapter.requests).toHaveLength(0)
  })

  it('refuses a text-only route', async () => {
    const { ctx, adapter } = await setup()
    adapter.modalities = ['text']
    const path = await writeImage('a.png', PNG_1X1)

    const result = await classify(ctx, { path })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('minicpm-v:latest')
  })
})

describe('classify_image argument and admission refusals', () => {
  it('refuses a blank path', async () => {
    const { ctx } = await setup()
    const result = await classify(ctx, { path: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('path must be a non-empty string')
  })

  it('refuses a path that claims no supported image', async () => {
    const { ctx } = await setup()
    const result = await classify(ctx, { path: join(dir, 'notes.txt') })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('only accepts PNG/JPEG/WebP/GIF paths')
  })

  it('refuses a media type this deployment does not accept', async () => {
    const { ctx } = await setup({ mediaTypes: ['image/png'] })
    const result = await classify(ctx, { path: join(dir, 'a.gif') })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('image/gif images are not accepted by this deployment')
  })

  it('refuses an absent file', async () => {
    const { ctx } = await setup()
    const result = await classify(ctx, { path: join(dir, 'missing.png') })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not found')
  })

  it('refuses a directory', async () => {
    const { ctx } = await setup()
    await mkdir(join(dir, 'pictures.png'))
    const result = await classify(ctx, { path: join(dir, 'pictures.png') })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not a regular file')
  })

  it('explains an extension that disagrees with the bytes', async () => {
    const { ctx } = await setup()
    const path = await writeImage('mislabeled.jpg', PNG_1X1)
    const result = await classify(ctx, { path })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the .jpg extension declares image/jpeg')
  })

  it('propagates an unrelated attachment admission failure unchanged', async () => {
    const { ctx } = await setup({ maxImagePixels: 4 })
    const path = await writeImage('big.png', PNG_3X3)
    const result = await classify(ctx, { path })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/pixel/i)
  })
})

describe('classify_image relay', () => {
  it('returns labels, logs the pre-dispatch record, and keeps the image out of the session', async () => {
    const { ctx, adapter } = await setup()
    adapter.answers = [
      'This is a digital illustration in an anime style.',
      'The character appears to be female.',
    ]
    await writeImage('subject.png', PNG_1X1)
    const session = sessionInWorkspace('classify-session')

    const result = await classify(ctx, { path: 'subject.png' }, agentWith(session))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('type: illustration')
    expect(text(result)).toContain('gender: female')
    expect(text(result)).toContain('This is a digital illustration in an anime style.')

    const logged = session.events.filter(event => event.type === 'tool-classify-image/request')
    expect(logged).toHaveLength(1)
    expect(logged[0]!.data).toMatchObject({
      mediaType: 'image/png',
      provider: 'ollama',
      model: 'minicpm-v:latest',
      maxTokens: 128,
      prompts: [CLASSIFY_IMAGE_PROMPTS.type, CLASSIFY_IMAGE_PROMPTS.gender],
    })

    // The two auxiliary requests carry the image; the calling session's log
    // carries no message content at all, so no later request can replay it.
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]!.messages[0]!.content[0]).toMatchObject({ type: 'image' })
    expect(adapter.requests[0]!.messages[0]!.content[1]).toEqual({ type: 'text', text: CLASSIFY_IMAGE_PROMPTS.type })
    expect(adapter.requests[1]!.messages[0]!.content[1]).toEqual({ type: 'text', text: CLASSIFY_IMAGE_PROMPTS.gender })
    expect(adapter.requests[0]!.sessionId).toBe(session.id)
    expect(adapter.requests[0]!.purpose).toBe('vision-classify')
    expect(session.events.some(event => event.type === 'user/message')).toBe(false)
  })

  it('classifies a photograph of a man and honors an explicit route override', async () => {
    const { ctx, adapter } = await setup({ config: { provider: 'ollama', model: 'llava:latest', maxTokens: 64 } })
    adapter.answers = ['It is a real photograph.', 'The person appears to be a man.']
    const path = await writeImage('portrait.png', PNG_1X1)

    const result = await classify(ctx, { path }, agentWith(sessionInWorkspace('photo-session')))
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      type: 'photo',
      gender: 'male',
      typeRaw: 'It is a real photograph.',
      genderRaw: 'The person appears to be a man.',
    })
    expect(adapter.requests[0]!.model).toBe('llava:latest')
    expect(adapter.requests[0]!.maxTokens).toBe(64)
  })

  it('runs for a direct caller with no agent, recording nothing and stamping no session', async () => {
    const { ctx, adapter } = await setup()
    adapter.answers = ['A cartoon.', 'A girl.']
    const path = await writeImage('direct.png', PNG_1X1)

    const result = await classify(ctx, { path })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ type: 'illustration', gender: 'female' })
    expect(adapter.requests[0]!.sessionId).toBeUndefined()
  })

  it('keeps a clipped one-sentence answer usable', async () => {
    const { ctx, adapter } = await setup()
    adapter.answers = ['This is an illustration', { finish: { kind: 'max-tokens' } }]
    const path = await writeImage('clipped.png', PNG_1X1)

    const result = await classify(ctx, { path })
    expect(result.isError).toBe(true)
    // The second request finished at the cap before emitting any text.
    expect(text(result)).toContain('produced no text')
  })

  it('accepts a max-tokens finish that still carried text', async () => {
    const { ctx, adapter } = await setup()
    adapter.answers = ['This is an illustration.', 'A woman.']
    const path = await writeImage('ok.png', PNG_1X1)
    const result = await classify(ctx, { path })
    expect(result.isError).toBe(false)
  })

  it.each([
    {
      label: 'an adapter failure',
      answers: [{ throws: 'ollama is not running' }] as Answer[],
      failure: 'ollama is not running',
    },
    {
      label: 'an unexpected tool request',
      answers: [{ finish: { kind: 'tool-calls' } }] as Answer[],
      failure: 'unexpectedly requested a tool',
    },
    {
      label: 'an unknown terminal reason',
      answers: [{ finish: { kind: 'moon-phase' } as unknown as FinishReason }] as Answer[],
      failure: 'unsupported finish reason "moon-phase"',
    },
  ])('fails on $label', async ({ answers, failure }) => {
    const { ctx, adapter } = await setup()
    adapter.answers = answers
    const path = await writeImage('fail.png', PNG_1X1)
    const result = await classify(ctx, { path })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(failure)
  })

  it('fails when the caller cancels mid-relay', async () => {
    const { ctx, adapter } = await setup()
    adapter.answers = ['An illustration.', 'A girl.']
    const path = await writeImage('cancel.png', PNG_1X1)
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))

    const result = await ctx.tools.execute({
      signal: controller.signal,
      callId: CallId('classify-cancelled'),
      name: 'classify_image',
      arguments: { path },
    })
    expect(result.isError).toBe(true)
  })
})

describe('classify_image presentation', () => {
  it('presents a read-family card that follows the image path', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('classify_image')?.presentCall?.({ path: 'a.png' })).toEqual({
      card: 'generic',
      title: 'Classify image a.png',
      kind: 'read',
      locations: [{ path: 'a.png' }],
    })
  })

  it('declares the read-only relay safe to run beside sibling calls, and its configured budget', async () => {
    const { ctx } = await setup({ config: { timeoutMs: 4000 } })
    const tool = ctx.tools.get('classify_image')
    expect(tool?.isConcurrencySafe?.({ path: 'a.png' })).toBe(true)
    expect(tool?.timeoutMs).toBe(4000)
  })

  it('unregisters the tool when its own fiber is disposed', async () => {
    const { ctx, toolFiber } = await setup()
    expect(ctx.tools.get('classify_image')).toBeDefined()
    await toolFiber.dispose()
    expect(ctx.tools.get('classify_image')).toBeUndefined()
  })
})
