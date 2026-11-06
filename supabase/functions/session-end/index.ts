// supabase/functions/session-end/index.ts
// Secure backend session termination and final usage reconciliation endpoint.
// 1. Authenticates user JWT.
// 2. Finalizes live_sessions row status to 'completed' and sets ended_at.
// 3. Atomically debits any final server-authoritative unbilled elapsed time.
// 4. Client-supplied seconds are ignored; database calculates billing from server clock.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface EndSessionPayload {
  session_id: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || ''

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

    const body: EndSessionPayload = await req.json()
    const sessionId = body.session_id

    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'session_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 2. Invoke server-authoritative end_live_session procedure
    const { data, error } = await supabaseAdmin.rpc('end_live_session', {
      p_session_id: sessionId,
      p_user_id: user.id,
    })

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const res = Array.isArray(data) ? data[0] : data

    return new Response(
      JSON.stringify({
        success: true,
        session_id: res.session_id,
        status: res.status,
        total_seconds: res.total_seconds,
        total_billed_cents: res.total_billed_cents,
        total_billed_usd: Number((res.total_billed_cents / 100).toFixed(2)),
        final_balance_cents: res.final_balance,
        final_balance_usd: Number((res.final_balance / 100).toFixed(2)),
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
