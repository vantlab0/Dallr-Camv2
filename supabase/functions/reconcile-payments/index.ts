// supabase/functions/reconcile-payments/index.ts
// Scheduled recovery worker for Paystack payments whose local record was left in
// 'initialized' / 'pending' state (for example because the client vanished after the
// gateway initialized the transaction, or because persisting gateway details failed).
//
// Security:
// - verify_jwt = false (see supabase/config.toml) because this is a machine-to-machine job.
// - Requires a strong shared secret in the `x-reconcile-secret` header.
// - Independently verifies every transaction with Paystack before crediting.
// - Never trusts client input for amounts, currency, status, or ownership.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-reconcile-secret',
}

interface ReconcilePayload {
  reference?: string
  older_than_minutes?: number
  limit?: number
  dry_run?: boolean
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  if (aBytes.length !== bBytes.length) return false
  let diff = 0
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i]
  }
  return diff === 0
}

interface ReconcileOutcome {
  reference: string
  result: 'credited' | 'already_processed' | 'failed' | 'abandoned' | 'pending' | 'error'
  message?: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || ''
    const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY') || ''
    const reconcileSecret = Deno.env.get('RECONCILE_SHARED_SECRET') || ''

    if (!supabaseUrl || !supabaseServiceKey || !paystackSecretKey) {
      console.error('reconcile-payments is missing required server credentials')
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!reconcileSecret) {
      console.error('RECONCILE_SHARED_SECRET is not configured; refusing to run reconciliation')
      return new Response(JSON.stringify({ error: 'Reconciliation secret not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const providedSecret = req.headers.get('x-reconcile-secret') || ''
    if (!constantTimeEqual(providedSecret, reconcileSecret)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body: ReconcilePayload = await req.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(body.limit) || 100, 1), 500)
    const olderThanMinutes = Math.max(Number(body.older_than_minutes) || 10, 1)
    const dryRun = Boolean(body.dry_run)

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    let query = supabaseAdmin
      .from('payment_records')
      .select('id, user_id, reference, ngn_amount, usd_credit_amount, status, created_at, metadata')
      .in('status', ['initialized', 'pending'])
      .order('created_at', { ascending: true })
      .limit(limit)

    if (body.reference) {
      query = query.eq('reference', body.reference.trim())
    } else {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()
      query = query.lt('created_at', cutoff)
    }

    const { data: records, error: queryError } = await query

    if (queryError) {
      console.error('Failed to load payment records for reconciliation:', queryError)
      return new Response(JSON.stringify({ error: queryError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const outcomes: ReconcileOutcome[] = []

    for (const record of records || []) {
      const reference = String(record.reference)

      try {
        const verifyRes = await fetch(
          `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${paystackSecretKey}` },
          }
        )

        const verifyData = await verifyRes.json().catch(() => ({}))

        if (!verifyRes.ok || !verifyData?.status) {
          outcomes.push({
            reference,
            result: 'error',
            message: verifyData?.message || 'Gateway verification inquiry failed',
          })
          continue
        }

        const gateway = verifyData.data || {}
        const gatewayStatus = String(gateway.status || 'pending')
        const verifiedReference = gateway.reference
        const verifiedCurrency = gateway.currency
        const verifiedAmount = Number(gateway.amount)
        const metadata = gateway.metadata || {}
        const metadataUserId = typeof metadata === 'string'
          ? (() => {
              try {
                return JSON.parse(metadata).user_id
              } catch {
                return undefined
              }
            })()
          : metadata.user_id

        if (dryRun) {
          outcomes.push({
            reference,
            result: gatewayStatus === 'success' ? 'credited' : 'pending',
            message: `dry_run: gateway_status=${gatewayStatus}`,
          })
          continue
        }

        if (gatewayStatus === 'success') {
          const valid =
            verifiedReference === reference &&
            String(verifiedCurrency).toUpperCase() === 'NGN' &&
            verifiedAmount === Number(record.ngn_amount) &&
            (!metadataUserId || metadataUserId === record.user_id)

          if (!valid) {
            console.error('Reconciliation integrity check failed:', {
              reference,
              verifiedReference,
              verifiedCurrency,
              verifiedAmount,
              expectedAmount: record.ngn_amount,
              metadataUserId,
              recordUserId: record.user_id,
            })

            await supabaseAdmin.rpc('credit_verified_payment', {
              p_reference: reference,
              p_gateway_status: 'failed',
              p_metadata: {
                reconciled_by: 'reconcile-payments',
                reason: 'integrity_check_failed',
                verified_reference: verifiedReference,
                verified_currency: verifiedCurrency,
                verified_amount: verifiedAmount,
              },
            })

            outcomes.push({ reference, result: 'failed', message: 'Integrity check failed' })
            continue
          }

          const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
            'credit_verified_payment',
            {
              p_reference: reference,
              p_gateway_status: 'success',
              p_verified_amount: verifiedAmount,
              p_verified_currency: verifiedCurrency,
              p_metadata: {
                reconciled_by: 'reconcile-payments',
                gateway_response: gateway.gateway_response || null,
                paid_at: gateway.paid_at || null,
                channel: gateway.channel || null,
              },
            }
          )

          if (rpcError) {
            outcomes.push({ reference, result: 'error', message: rpcError.message })
            continue
          }

          const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
          outcomes.push({
            reference,
            result: result?.already_processed ? 'already_processed' : result?.success ? 'credited' : 'failed',
            message: result?.message,
          })
        } else if (gatewayStatus === 'failed' || gatewayStatus === 'abandoned') {
          await supabaseAdmin.rpc('credit_verified_payment', {
            p_reference: reference,
            p_gateway_status: gatewayStatus,
            p_metadata: {
              reconciled_by: 'reconcile-payments',
              gateway_response: gateway.gateway_response || null,
            },
          })

          outcomes.push({ reference, result: gatewayStatus as 'failed' | 'abandoned' })
        } else {
          outcomes.push({ reference, result: 'pending' })
        }
      } catch (err) {
        console.error(`Reconciliation error for ${reference}:`, err)
        outcomes.push({
          reference,
          result: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        scanned: records?.length || 0,
        outcomes,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Unexpected error in reconcile-payments:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
