// supabase/functions/session-heartbeat/index.ts
// Authoritative backend usage metering endpoint.
// 1. Authenticates caller via Supabase JWT.
// 2. Meters live session strictly using server timestamps and lease policy.
// 3. Charges ONLY while the server-side live_sessions.billing_state is 'billable'.
//    Reconnecting / disconnected / idle clients are paused and never charged.
// 4. Atomically debits wallet and updates live_sessions.
// 5. Returns current balance and signals stopRequested when balance is exhausted.
// 6. Ignores any client-supplied cumulative_seconds to prevent duration manipulation.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type BillingStateTransition = 'billable' | 'paused' | 'idle'

interface HeartbeatPayload {
  session_id?: string
  decart_session_id?: string
  action?: 'start' | 'heartbeat' | 'billing_state'
  billing_state?: BillingStateTransition
}

const ALLOWED_BILLING_STATES: BillingStateTransition[] = ['billable', 'paused', 'idle']

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || Deno.env.get('SUPABASE_PUBLIC_URL') || ''
    const supabaseServiceKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || ''

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
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

    const body: HeartbeatPayload = await req.json()
    const action = body.action || (body.session_id ? 'heartbeat' : 'start')

    if (action === 'start') {
      // 2. Start a new live session. New sessions begin in billing_state='idle'
      //    and cannot accrue charges until explicitly resumed by the client.
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
          billing_state: 'idle',
          started_at: sessionRow.started_at,
          current_balance_cents: sessionRow.current_balance,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const sessionId = body.session_id
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'session_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 3. Explicit server-authoritative billing-state transition
    if (action === 'billing_state') {
      const nextState = body.billing_state
      if (!nextState || !ALLOWED_BILLING_STATES.includes(nextState)) {
        return new Response(
          JSON.stringify({ error: 'billing_state must be one of: billable, paused, idle' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      const { data, error } = await supabaseAdmin.rpc('set_session_billing_state', {
        p_session_id: sessionId,
        p_user_id: user.id,
        p_billing_state: nextState,
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
          billing_state: res.billing_state,
          status: res.status,
          cumulative_seconds: res.cumulative_seconds,
          billed_cents: res.billed_cents,
          new_balance_cents: res.new_balance,
          new_balance_usd: Number((res.new_balance / 100).toFixed(2)),
          changed: res.changed,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. Periodic Heartbeat Metering (Server-Authoritative)
    // Notice: client cumulative_seconds is explicitly ignored.
    // Elapsed billable duration is calculated solely by the server database clock and
    // only while billing_state = 'billable'.
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
        billing_state: res.billing_state,
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
