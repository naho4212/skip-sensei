/**
 * Minimal ambient types for Chrome's built-in AI Prompt API (Gemini Nano),
 * available to extension service workers since Chrome 138. Not yet covered by
 * @types/chrome.
 */

type BuiltinAiAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available'

interface BuiltinAiSession {
  prompt(
    input: string,
    options?: { responseConstraint?: object; signal?: AbortSignal },
  ): Promise<string>
  destroy(): void
}

interface BuiltinAiLanguageModel {
  availability(): Promise<BuiltinAiAvailability>
  create(options?: {
    /** @deprecated Chrome deprecated this create() option; use model defaults. */
    temperature?: number
    /** @deprecated Chrome deprecated this create() option; use model defaults. */
    topK?: number
    monitor?: (m: EventTarget) => void
    signal?: AbortSignal
  }): Promise<BuiltinAiSession>
}

// eslint-disable-next-line no-var
declare var LanguageModel: BuiltinAiLanguageModel | undefined
