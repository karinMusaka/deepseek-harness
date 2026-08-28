/**
 * The model-facing `classify_image` tool: read one local image file and relay
 * it to an auxiliary vision route, returning only text labels.
 *
 * The image never enters the calling session's message history. A durable
 * `image` block committed to the conversation would pin every later request on
 * a text-only route to a permanent `UNSUPPORTED_CONTENT` failure (see
 * `assertTextOnly` in `@deepseek-ai/dsh-llm-deepseek`), so the attachment
 * reference lives only in the ephemeral message array built inside
 * {@link askVisionModel} and in the log-only pre-dispatch record. What reaches
 * the calling model is the closed label pair plus the two raw sentences.
 * @module @deepseek-ai/dsh-tool-classify-image/classify
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { FsError } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import { BlockAssembler, createUserMessage, deepFreeze } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import { normalizeImageGender, normalizeImageType } from './normalize.ts'
import type { ImageSubjectGender, ImageSubjectType } from './normalize.ts'

/** Extensions this tool accepts; the attachment service's magic-byte check stays authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * The two fixed questions asked of the vision route, in dispatch order. They
 * are package-owned prose rather than configuration: {@link normalizeImageType}
 * and {@link normalizeImageGender} match markers these exact questions elicit,
 * so a replaced question silently degrades the labels.
 */
export const CLASSIFY_IMAGE_PROMPTS = {
  /** Elicits the photograph-or-illustration sentence. */
  type: 'Is this image a real photograph or a digital illustration/anime drawing? Answer in one sentence.',
  /** Elicits the apparent-gender sentence. */
  gender: 'What is the apparent gender of the person/character in this image? Answer in one sentence.',
} as const

/** The validated auxiliary route and generation policy one registration runs under. */
export interface ClassifyImagePolicy {
  /** Registered provider route carrying the vision model. */
  readonly provider: string
  /** Exact vision model id passed to that provider. */
  readonly model: string
  /** Output-token cap applied to each of the two auxiliary requests. */
  readonly maxTokens: number
  /** Cooperative tool-call budget in milliseconds. */
  readonly timeoutMs: number
}

/** Exact auxiliary vision request recorded before either dispatch. */
export interface ClassifyImageRequestEventData {
  /** Backend-resolved path of the classified file. */
  readonly path: string
  /** Durable attachment identity the two requests carry. */
  readonly attachmentId: string
  /** Media type verified from the stored bytes. */
  readonly mediaType: ImageMediaType
  /** Exact auxiliary route. */
  readonly provider: string
  readonly model: string
  /** The two fixed questions, in dispatch order. */
  readonly prompts: string[]
  /** Exact per-request output-token cap. */
  readonly maxTokens: number
}

/** The canonical value declared by the `classify_image` output schema. */
export interface ClassifyImageValue {
  /** Photograph, drawn image, or no usable answer. */
  type: ImageSubjectType
  /** Apparent gender of the depicted person or character, or no usable answer. */
  gender: ImageSubjectGender
  /** The vision model's unmodified sentence behind {@link ClassifyImageValue.type}. */
  typeRaw: string
  /** The vision model's unmodified sentence behind {@link ClassifyImageValue.gender}. */
  genderRaw: string
}

/**
 * Map a model-supplied path to its declared image media type by extension.
 * @param filePath - the raw `path` argument, not yet resolved.
 * @returns the declared media type, or undefined when the path claims no supported image.
 */
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * Translate one terminal finish reason into an auxiliary-call failure.
 *
 * `max-tokens` is not a failure here: the questions ask for one sentence and
 * the cap exists only to bound a runaway local model, so a clipped sentence
 * still carries the markers the normalizers match.
 * @param finish - the assembled stream's terminal reason.
 * @returns the failure to throw, or undefined when the text is usable.
 */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
    case 'max-tokens':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'tool-calls':
      return new Error('classify_image: the vision model unexpectedly requested a tool')
    default:
      // FinishReasonMap is merge-extensible: an adapter-specific reason this
      // package does not know is a failure, not silently usable text.
      return new Error(`classify_image: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Ask the auxiliary vision route one question about one committed image.
 *
 * The message array is a local variable that no session, agent, or history
 * ever sees; it exists for the duration of this call only.
 * @param ctx - context exposing the injected `llm` service.
 * @param policy - the validated route and generation policy.
 * @param ref - the durable image reference both requests share.
 * @param prompt - one of {@link CLASSIFY_IMAGE_PROMPTS}.
 * @param exec - the running tool execution, supplying cancellation and session identity.
 * @returns the model's concatenated text, trimmed.
 */
async function askVisionModel(
  ctx: Context,
  policy: ClassifyImagePolicy,
  ref: ImageAttachmentRef,
  prompt: string,
  exec: ToolRunContext,
): Promise<string> {
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'image', attachment: ref }, { type: 'text', text: prompt }],
    source: { kind: 'plugin', plugin: 'dsh-tool-classify-image' },
  })]
  const sessionId = exec.agent?.session.id
  const options: GenerateOptions = deepFreeze({
    provider: policy.provider,
    model: policy.model,
    messages,
    maxTokens: policy.maxTokens,
    purpose: 'vision-classify',
    signal: exec.signal,
    ...sessionId === undefined ? {} : { sessionId },
  })
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    exec.signal.throwIfAborted()
    assembler.push(chunk)
  }
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  const text = blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
  if (text.length === 0) throw new Error(`classify_image: model "${policy.model}" produced no text`)
  return text
}

/**
 * Require the configured auxiliary route to declare image input before any
 * filesystem or attachment work happens, so a text-only route refuses without
 * side effects.
 * @param ctx - context exposing the injected `llm` service.
 * @param policy - the validated route and generation policy.
 * @param signal - cancellation for the adapter-owned metadata lookup.
 */
async function assertVisionRoute(ctx: Context, policy: ClassifyImagePolicy, signal: AbortSignal): Promise<void> {
  const info = await ctx.llm.resolveModelInfo(policy.provider, policy.model, signal)
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(
      `classify_image: model "${policy.model}" on provider "${policy.provider}" does not declare image input;`
      + ' point this tool at a vision model and declare `inputModalities: [text, image]` for it in the provider catalog',
    )
  }
}

/**
 * Register the `classify_image` tool into the given context.
 * @param ctx - the registration scope, whose `tools`, `llm`, `fs`, and
 *   `attachments` services the tool uses; the registration disposes with the
 *   plugin fiber.
 * @param policy - the validated route and generation policy for this registration.
 */
export function applyClassifyImageTool(ctx: Context, policy: ClassifyImagePolicy): void {
  ctx.tools.register(defineTool({
    name: 'classify_image',
    description: 'Classify a local person image with an auxiliary vision model: whether it is a photograph or an'
      + ' illustration, and the apparent gender of the person or character. The image itself is never added to this'
      + ' conversation, so this tool works on a text-only model.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to a PNG/JPEG/WebP/GIF file, resolved by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['photo', 'illustration', 'unknown'], required: true },
          gender: { type: 'string', enum: ['male', 'female', 'unknown'], required: true },
          typeRaw: { type: 'string', required: true },
          genderRaw: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `type: ${value.type}\ngender: ${value.gender}\n\nvision model answers:\n- ${value.typeRaw}\n- ${value.genderRaw}`,
      }],
    },
    timeoutMs: policy.timeoutMs,
    // Content-addressed attachment writes are idempotent and the auxiliary
    // requests mutate no parent-agent state, so concurrent calls cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<ClassifyImageValue> {
      if (args.path.trim().length === 0) throw new Error('path must be a non-empty string')
      const mediaType = imageMediaTypeForPath(args.path)
      if (mediaType === undefined) {
        throw new Error(`cannot classify "${args.path}": classify_image only accepts PNG/JPEG/WebP/GIF paths`)
      }
      if (!ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot classify "${args.path}": ${mediaType} images are not accepted by this deployment`)
      }
      await assertVisionRoute(ctx, policy, exec.signal)

      const cwd = exec.agent?.session.header.cwd
      const target = await ctx.fs.resolve(args.path, {
        ...cwd === undefined ? {} : { cwd },
        signal: exec.signal,
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot classify "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot classify "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }

      const byteCap = Math.min(
        ctx.attachments.imageLimits.maxImageBytes,
        ctx.attachments.imageLimits.maxMessageImageBytes,
      )
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      let ref: ImageAttachmentRef
      try {
        ref = await ctx.attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError) || error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        const extension = extname(target.displayPath).toLowerCase()
        throw new Error(
          `cannot classify "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes`
          + ' use a different image format; convert the file or rename it to match its actual format',
          { cause: error },
        )
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

      // Log-only pre-dispatch record: the two auxiliary requests are otherwise
      // invisible in the session log, because their image and prompts never
      // become conversation messages. A direct non-agent call has no session
      // to reconstruct and therefore nothing to record.
      exec.agent?.session.append('tool-classify-image/request', {
        path: target.displayPath,
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        provider: policy.provider,
        model: policy.model,
        prompts: [CLASSIFY_IMAGE_PROMPTS.type, CLASSIFY_IMAGE_PROMPTS.gender],
        maxTokens: policy.maxTokens,
      })

      const typeRaw = await askVisionModel(ctx, policy, ref, CLASSIFY_IMAGE_PROMPTS.type, exec)
      const genderRaw = await askVisionModel(ctx, policy, ref, CLASSIFY_IMAGE_PROMPTS.gender, exec)
      return {
        type: normalizeImageType(typeRaw),
        gender: normalizeImageGender(genderRaw),
        typeRaw,
        genderRaw,
      }
    },
    // Pure display: a generic card with a follow-along location on the image file.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Classify image ${args.path}`,
        kind: 'read',
        locations: [{ path: args.path }],
      }
    },
  }))
}
