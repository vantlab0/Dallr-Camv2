// supabase/functions/initialize-payment/index.ts
// Initiates secure Paystack payment on the backend.
// Enforces minimum $15 top-up server-side, calculates NGN in kobo using trusted rate,
// generates unique payment reference, records transaction in payment_records,
// and contacts Paystack API with secret key.

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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY') || ''
    const exchangeRate = Number(Deno.env.get('PAYSTACK_USD_TO_NGN_RATE') || '1550')

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

    // 2. Validate request payload & enforce minimum $15 USD
    const body: InitializePaymentPayload = await req.json()
    const amountUSD = Number(body.amount_usd)

    if (isNaN(amountUSD) || amountUSD < 15) {
      return new Response(
        JSON.stringify({ error: 'Minimum top-up amount is $15.00 USD' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // Precise integer minor units
    // USD cents: $15.00 -> 1500 cents
    const usdCents = Math.round(amountUSD * 100)
    // NGN kobo: 1 NGN = 100 kobo. Paystack expects minor units (kobo).
    // NGN amount in full NGN = amountUSD * exchangeRate
    // NGN amount in kobo = Math.round(amountUSD * exchangeRate * 100)
    const ngnKobo = Math.round(amountUSD * exchangeRate * 100)
    const uniqueRef = `dallr_${user.id.substring(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 10000)}`

    let authorizationUrl = ''
    let accessCode = ''

    // 3. Initialize Paystack transaction if secret key is present
    if (paystackSecretKey) {
      const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
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

      const paystackData = await paystackRes.json()
      if (!paystackRes.ok || !paystackData.status) {
        return new Response(
          JSON.stringify({
            error: paystackData.message || 'Failed to initialize Paystack payment',
          }),
          {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
      }

      authorizationUrl = paystackData.data.authorization_url
      accessCode = paystackData.data.access_code
    } else {
      // Mock gateway URL for testing environments without live keys
      authorizationUrl = `https://checkout.paystack.com/mock_${uniqueRef}`
      accessCode = `mock_code_${uniqueRef}`
    }

    // 4. Record payment record with status 'initialized'
    const { error: insertError } = await supabaseAdmin.from('payment_records').insert({
      user_id: user.id,
      reference: uniqueRef,
      ngn_amount: ngnKobo,
      usd_credit_amount: usdCents,
      exchange_rate_used: exchangeRate,
      status: 'initialized',
      paystack_access_code: accessCode,
      authorization_url: authorizationUrl,
      metadata: {
        user_email: user.email,
        initiated_at: new Date().toISOString(),
      },
    })

    if (insertError) {
      return new Response(
        JSON.stringify({ error: `Failed to create payment record: ${insertError.message}` }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    return new Response(
      JSON.stringify({
        reference: uniqueRef,
        authorization_url: authorizationUrl,
        access_code: accessCode,
        ngn_amount_kobo: ngnKobo,
        usd_credit_amount_cents: usdCents,
        exchange_rate_used: exchangeRate,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
