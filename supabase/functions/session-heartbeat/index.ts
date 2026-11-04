// supabase/functions/session-heartbeat/index.ts
// Authoritative backend usage metering endpoint.
// 1. Authenticates caller via Supabase JWT.
// 2. Meters live session strictly using server timestamps and lease policy.
// 3. Atomically debits wallet and updates live_sessions.
// 4. Returns current balance and signals stopRequested when balance is exhausted.
// 5. Ignores any client-supplied cumulative_seconds to prevent duration manipulation.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface HeartbeatPayload {
  session_id?: string
  decart_session_id?: string
  action?: 'start' | 'heartbeat'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

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

    const body: HeartbeatPayload = await req.json()
    const action = body.action || (body.session_id ? 'heartbeat' : 'start')

    if (action === 'start') {
      // 2. Start a new live session
      const { data, error } = await supabaseAdmin.rpc('start_live_session', {
        p_user_id: user.id,
        p_decart_session_id: body.decart_session_id || null,
      })

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const sessionRow = Array.isArray(data) ? data[0] : data

      return new Response(
        JSON.stringify({
          success: true,
          session_id: sessionRow.session_id,
          status: sessionRow.status,
          started_at: sessionRow.started_at,
          current_balance_cents: sessionRow.current_balance,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. Periodic Heartbeat Metering (Server-Authoritative)
    const sessionId = body.session_id
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'session_id is required for heartbeat' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Notice: Client cumulative_seconds is explicitly ignored.
    // Elapsed billable duration is calculated solely by the server database clock.
    const { data: meterData, error: meterError } = await supabaseAdmin.rpc('heartbeat_and_meter_session', {
      p_session_id: sessionId,
      p_user_id: user.id,
    })

    if (meterError) {
      return new Response(JSON.stringify({ error: meterError.message }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const res = Array.isArray(meterData) ? meterData[0] : meterData

    return new Response(
      JSON.stringify({
        success: true,
        session_id: res.session_id,
        status: res.status,
        cumulative_seconds: res.cumulative_seconds,
        billed_cents: res.billed_cents,
        new_balance_cents: res.new_balance,
        new_balance_usd: Number((res.new_balance / 100).toFixed(2)),
        stop_requested: res.stop_requested,
        reason: res.reason,
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
