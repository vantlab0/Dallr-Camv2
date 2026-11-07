// supabase/functions/initialize-payment/index.ts
// Initiates secure Paystack payment on the backend.
//
// RELIABILITY ORDERING (critical):
//   1. Insert a tracked payment_records row FIRST (status='initialized').
//   2. Only then contact Paystack.
//   3. If Paystack succeeds, persist the authorization URL / access code with retries.
//
// This guarantees that a successful Paystack initialization can never produce an
// untracked payment. If step 3 fails, the row still exists and the scheduled
// reconcile-payments worker will recover and credit it after independent verification.
//
// All mock fallbacks are strictly prohibited.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface InitializePaymentPayload {
  amount_usd: number
  callback_url?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function updatePaymentRecordWithRetry(
  supabaseAdmin: ReturnType<typeof createClient>,
  reference: string,
  patch: Record<string, unknown>,
  attempts = 4
): Promise<{ ok: boolean; error?: string }> {
  let lastError: string | undefined

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { error } = await supabaseAdmin
      .from('payment_records')
      .update(patch)
      .eq('reference', reference)
      .eq('status', 'initialized')

    if (!error) {
      return { ok: true }
    }

    lastError = error.message
    console.warn(`payment_records update attempt ${attempt}/${attempts} failed for ${reference}:`, error.message)

    if (attempt < attempts) {
      await sleep(250 * Math.pow(2, attempt - 1))
    }
  }

  return { ok: false, error: lastError }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || Deno.env.get('SUPABASE_PUBLIC_URL') || ''
    const supabaseServiceKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || ''
    const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY') || ''
    const paystackPublicKey = Deno.env.get('PAYSTACK_PUBLIC_KEY') || ''
    const exchangeRate = Number(Deno.env.get('PAYSTACK_USD_TO_NGN_RATE') || '1550')

    if (!paystackSecretKey) {
      console.error('PAYSTACK_SECRET_KEY environment variable is not configured')
      return new Response(JSON.stringify({ error: 'Payment gateway configuration error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Supabase server credentials are not configured')
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      console.error('Invalid PAYSTACK_USD_TO_NGN_RATE configuration')
      return new Response(JSON.stringify({ error: 'Payment gateway configuration error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 1. Authenticate user from Bearer JWT
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)
    const jwt = authHeader.replace('Bearer ', '').trim()
    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(jwt)

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid or expired authentication session' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!user.email) {
      return new Response(JSON.stringify({ error: 'Account is missing an email address' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 2. Validate request payload & enforce minimum $15 USD
    const body: InitializePaymentPayload = await req.json()
    const amountUSD = Number(body.amount_usd)

    if (isNaN(amountUSD) || amountUSD < 15) {
      return new Response(JSON.stringify({ error: 'Minimum top-up amount is $15.00 USD' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Precise integer minor units
    const usdCents = Math.round(amountUSD * 100)
    const ngnKobo = Math.round(amountUSD * exchangeRate * 100)
    const uniqueRef = `dallr_${user.id.substring(0, 8)}_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`

    // 3. INSERT FIRST. If this fails we abort *before* contacting Paystack,
    //    so a gateway-side payment can never exist without a tracking row.
    const { error: insertError } = await supabaseAdmin.from('payment_records').insert({
      user_id: user.id,
      reference: uniqueRef,
      ngn_amount: ngnKobo,
      usd_credit_amount: usdCents,
      exchange_rate_used: exchangeRate,
      status: 'initialized',
      metadata: {
        user_email: user.email,
        initiated_at: new Date().toISOString(),
        amount_usd: amountUSD,
        client: 'initialize-payment',
      },
    })

    if (insertError) {
      console.error('CRITICAL: failed to insert payment record before contacting Paystack:', insertError)
      return new Response(
        JSON.stringify({
          error: 'Unable to record payment intent. The payment gateway was not contacted.',
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // 4. Initialize Paystack transaction strictly against official API
    let paystackRes: Response
    let paystackData: Record<string, unknown>

    try {
      paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: user.email,
          amount: ngnKobo,
          reference: uniqueRef,
          currency: 'NGN',
          callback_url: body.callback_url || undefined,
          metadata: {
            user_id: user.id,
            usd_credit_amount_cents: usdCents,
            exchange_rate_used: exchangeRate,
            app: 'Dallr Cam',
          },
        }),
      })
      paystackData = await paystackRes.json()
    } catch (networkError) {
      const message = networkError instanceof Error ? networkError.message : 'Network error contacting payment gateway'
      console.error('Paystack initialization network error:', message)

      await updatePaymentRecordWithRetry(supabaseAdmin, uniqueRef, {
        status: 'failed',
        metadata: {
          user_email: user.email,
          failed_at: new Date().toISOString(),
          failure_reason: 'network_error_before_gateway_confirmation',
          failure_detail: message,
        },
      })

      return new Response(
        JSON.stringify({ error: 'Payment gateway unreachable. No payment was initialized.' }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    const paystackStatus = Boolean(paystackData?.status)
    const paystackPayload = (paystackData?.data || {}) as Record<string, unknown>

    if (!paystackRes.ok || !paystackStatus) {
      const message = String(paystackData?.message || 'Failed to initialize Paystack payment')
      console.error('Paystack initialization failure:', paystackData)

      await updatePaymentRecordWithRetry(supabaseAdmin, uniqueRef, {
        status: 'failed',
        metadata: {
          user_email: user.email,
          failed_at: new Date().toISOString(),
          failure_reason: 'gateway_rejected_initialization',
          failure_detail: message,
        },
      })

      return new Response(JSON.stringify({ error: message }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const authorizationUrl = paystackPayload.authorization_url as string | undefined
    const accessCode = paystackPayload.access_code as string | undefined

    if (!authorizationUrl || !accessCode) {
      console.error('Paystack returned an incomplete initialization payload:', paystackData)

      await updatePaymentRecordWithRetry(supabaseAdmin, uniqueRef, {
        status: 'failed',
        metadata: {
          user_email: user.email,
          failed_at: new Date().toISOString(),
          failure_reason: 'incomplete_gateway_initialization_response',
        },
      })

      return new Response(JSON.stringify({ error: 'Invalid response from payment gateway' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 5. Persist gateway details. The tracking row already exists, so a failure here
    //    is recoverable by reconcile-payments rather than leaving an untracked payment.
    const updateResult = await updatePaymentRecordWithRetry(supabaseAdmin, uniqueRef, {
      paystack_access_code: accessCode,
      authorization_url: authorizationUrl,
      metadata: {
        user_email: user.email,
        initiated_at: new Date().toISOString(),
        amount_usd: amountUSD,
        initialization_confirmed_at: new Date().toISOString(),
      },
    })

    if (!updateResult.ok) {
      console.error(
        `Payment ${uniqueRef} is tracked but gateway details could not be persisted (${updateResult.error}). ` +
          'reconcile-payments will recover it.'
      )
    }

    return new Response(
      JSON.stringify({
        reference: uniqueRef,
        authorization_url: authorizationUrl,
        access_code: accessCode,
        public_key: paystackPublicKey,
        ngn_amount_kobo: ngnKobo,
        usd_credit_amount_cents: usdCents,
        exchange_rate_used: exchangeRate,
        recovery_pending: !updateResult.ok,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Unexpected error in initialize-payment:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
