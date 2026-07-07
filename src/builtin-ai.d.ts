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
    options?: { responseConstraint?: object },
  ): Promise<string>
  destroy(): void
}

interface BuiltinAiLanguageModel {
  availability(): Promise<BuiltinAiAvailability>
  create(options?: {
    temperature?: number
    topK?: number
    monitor?: (m: EventTarget) => void
  }): Promise<BuiltinAiSession>
}

// eslint-disable-next-line no-var
declare var LanguageModel: BuiltinAiLanguageModel | undefined
