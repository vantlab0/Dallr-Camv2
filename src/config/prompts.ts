/**
 * Transformation prompt configuration for live video calls.
 * Used as visual reference instructions for real-time video transformation engines (Decart).
 */

export const DEFAULT_TRANSFORMATION_PROMPT =
  "Use the uploaded image as the primary visual reference for transforming the incoming live video stream. Reproduce the subject's appearance, facial characteristics, clothing, environment, background, lighting and overall composition as closely as possible. Maintain natural movement and visual consistency throughout the real-time transformation."

export interface PromptConfig {
  defaultPrompt: string
  version: string
  lastUpdated: string
}

let activePrompt = DEFAULT_TRANSFORMATION_PROMPT

export const promptManager = {
  getDefaultPrompt(): string {
    return DEFAULT_TRANSFORMATION_PROMPT
  },

  getActivePrompt(): string {
    return activePrompt
  },

  setActivePrompt(prompt: string): void {
    if (!prompt || !prompt.trim()) {
      activePrompt = DEFAULT_TRANSFORMATION_PROMPT
      return
    }
    activePrompt = prompt.trim()
  },

  resetPrompt(): void {
    activePrompt = DEFAULT_TRANSFORMATION_PROMPT
  },
}
