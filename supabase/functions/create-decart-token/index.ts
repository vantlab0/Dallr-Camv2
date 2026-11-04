// supabase/functions/create-decart-token/index.ts
// Issues authorized short-lived Decart client tokens for real-time video transformation.
// Authenticates user JWT, verifies wallet eligibility (has at least 1 second balance = $0.04 USD / 4 cents),
// and creates a client token scoped strictly to 'lucy-2.5'.
// Uses the officially supported Decart SDK endpoint and request structure.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const decartApiKey = Deno.env.get('DECART_API_KEY') || ''

    if (!decartApiKey) {
      return new Response(
        JSON.stringify({ error: 'DECART_API_KEY is not configured on the backend.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
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

    // 2. Validate wallet eligibility (user must have at least 1 second balance: 4 cents / $0.04 USD)
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('balance, currency')
      .eq('user_id', user.id)
      .single()

    if (walletError || !wallet) {
      return new Response(
        JSON.stringify({ error: 'Wallet not found. Please initialize wallet before starting stream.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const MINIMUM_BALANCE_CENTS = 4 // $0.04 USD
    if (wallet.balance < MINIMUM_BALANCE_CENTS) {
      return new Response(
        JSON.stringify({
          error: `Insufficient wallet balance ($${(wallet.balance / 100).toFixed(2)} USD). Minimum required to start live stream is $0.04 USD.`,
        }),
        { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. Request short-lived client token from Decart API (scoped to lucy-2.5 with 300s expiry)
    const decartRes = await fetch('https://api.decart.ai/v1/client_tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${decartApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        allowedModels: ['lucy-2.5'],
        expiresIn: 300,
        metadata: {
          user_id: user.id,
          app: 'Dallr Cam',
        },
      }),
    })

    if (!decartRes.ok) {
      const errText = await decartRes.text()
      return new Response(
        JSON.stringify({ error: `Decart API error: ${errText}` }),
        { status: decartRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const decartData = await decartRes.json()
    const apiKey = decartData.apiKey || decartData.token || decartData.client_token || decartData.access_token
    const expiresAt = decartData.expiresAt || decartData.expires_at || new Date(Date.now() + 300000).toISOString()

    return new Response(
      JSON.stringify({
        apiKey,
        token: decartData.token || apiKey,
        expiresAt,
        permissions: decartData.permissions || { models: ['lucy-2.5'] },
        constraints: decartData.constraints || null,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Internal Server Error'
    return new Response(
      JSON.stringify({ error: errorMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
