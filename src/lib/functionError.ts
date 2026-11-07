/**
 * Extracts the real HTTP status code and server error body from a Supabase
 * Edge Functions error.
 *
 * When an Edge Function returns a non-2xx status, `@supabase/functions-js`
 * throws a `FunctionsHttpError` whose `context` property is the raw `Response`
 * object. The response body contains the server-side error message. This
 * helper reads that body so callers can report the actual status code and
 * server error instead of the generic "Edge Function returned a non-2xx
 * status code" / "(unknown)" message.
 *
 * Secrets (API keys, JWTs, authorization headers) are never read from the
 * response and never logged by this helper.
 */
export interface ExtractedFunctionError {
  status: number | null
  statusText: string
  message: string
  body: unknown
}

export async function extractFunctionError(
  error: unknown
): Promise<ExtractedFunctionError> {
  const context = (error as { context?: unknown })?.context
  let status: number | null = null
  let statusText = ''
  let body: unknown = null
  let serverMessage = ''

  if (context instanceof Response) {
    status = context.status
    statusText = context.statusText

    // Read the Edge Function response body once (json() consumes the body).
    try {
      body = await context.json()
    } catch {
      try {
        body = await context.text()
      } catch {
        body = null
      }
    }

    if (body && typeof body === 'object') {
      const obj = body as { error?: string | null; message?: string | null }
      serverMessage = String(obj.error ?? obj.message ?? '')
    } else if (typeof body === 'string') {
      serverMessage = body
    }
  }

  const underlying = error instanceof Error ? error.message : String(error)
  const message = serverMessage || underlying || 'Edge Function error'

  return { status, statusText, message, body }
}

/**
 * Logs a function error safely: function name, HTTP status code and the
 * server error message only. No API keys, JWTs or secrets are emitted.
 */
export function logFunctionError(
  functionName: string,
  status: number | null,
  statusText: string,
  serverMessage: string
): void {
  console.error(
    `[${functionName}] Edge Function HTTP ${status ?? 'unknown'} ${statusText}: ${serverMessage}`
  )
}
