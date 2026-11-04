// supabase/functions/verify-payment/index.ts
// Authorized backend payment verification endpoint.
// Allows the desktop app to query payment resolution securely.
// Uses backend PAYSTACK_SECRET_KEY to verify status directly with Paystack API.
// Validates currency, amount, status, and user ownership, then invokes credit_verified_payment.
// Desktop client-side claims or parameters can NEVER credit a wallet directly.
// All mock fallbacks are strictly prohibited.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface VerifyPaymentPayload {
  reference: string
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY') || ''

    // Missing Paystack or Supabase credentials must cause immediate secure failure
    if (!paystackSecretKey) {
      console.error('PAYSTACK_SECRET_KEY environment variable is not configured')
      return new Response(
        JSON.stringify({ error: 'Payment gateway configuration error' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Supabase server credentials are not configured')
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
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

    // 2. Parse reference
    const body: VerifyPaymentPayload = await req.json()
    const reference = body.reference?.trim()

    if (!reference) {
      return new Response(JSON.stringify({ error: 'Missing payment reference' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 3. Verify user owns the payment record
    const { data: record, error: recordError } = await supabaseAdmin
      .from('payment_records')
      .select('*')
      .eq('reference', reference)
      .maybeSingle()

    if (recordError || !record) {
      return new Response(JSON.stringify({ error: 'Payment record not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (record.user_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Unauthorized to verify this payment' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // If already verified as success, return current state idempotently
    if (record.status === 'success') {
      const { data: wallet } = await supabaseAdmin
        .from('wallets')
        .select('balance')
        .eq('user_id', user.id)
        .single()

      return new Response(
        JSON.stringify({
          status: 'success',
          reference,
          usd_credit_amount_cents: record.usd_credit_amount,
          new_balance: wallet?.balance ?? 0,
          already_processed: true,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // 4. Contact Paystack API directly (authoritative independent verification)
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
        },
      }
    )
    const paystackData = await paystackRes.json()

    if (!paystackRes.ok || !paystackData.status) {
      console.error('Paystack verification inquiry failed:', paystackData)
      return new Response(
        JSON.stringify({
          error: paystackData.message || 'Payment verification failed at gateway',
          status: 'failed',
          reference,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    const gatewayData = paystackData.data
    const gatewayStatus = gatewayData?.status // 'success' | 'failed' | 'abandoned'
    const gatewayAmount = gatewayData?.amount // in kobo
    const gatewayCurrency = gatewayData?.currency // should be 'NGN'
    const gatewayReference = gatewayData?.reference

    // Integrity validations:
    // Reference must match exactly
    if (gatewayReference !== reference) {
      console.error('Reference mismatch:', { gatewayReference, reference })
      return new Response(
        JSON.stringify({ error: 'Transaction reference mismatch', status: 'failed' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // Currency must match NGN
    if (gatewayCurrency !== 'NGN') {
      console.error('Currency mismatch:', { gatewayCurrency, expected: 'NGN' })
      return new Response(
        JSON.stringify({ error: 'Transaction currency mismatch', status: 'failed' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    // Actual paid amount must match the initialized amount in record
    if (Number(gatewayAmount) !== Number(record.ngn_amount)) {
      console.error('Amount mismatch:', { gatewayAmount, expected: record.ngn_amount })
      return new Response(
        JSON.stringify({ error: 'Transaction amount mismatch', status: 'failed' }),
        {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    const gatewayMeta = {
      gateway_response: gatewayData.gateway_response,
      paid_at: gatewayData.paid_at,
      channel: gatewayData.channel,
      verified_by: 'verify-payment',
    }

    // 5. If status is resolved, invoke credit_verified_payment stored procedure
    if (gatewayStatus === 'success') {
      const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
        'credit_verified_payment',
        {
          p_reference: reference,
          p_gateway_status: 'success',
          p_metadata: gatewayMeta,
        }
      )

      if (rpcError) {
        console.error('Database error in credit_verified_payment:', rpcError)
        return new Response(JSON.stringify({ error: rpcError.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const result = Array.isArray(rpcData) ? rpcData[0] : rpcData

      return new Response(
        JSON.stringify({
          status: 'success',
          reference,
          usd_credit_amount_cents: result?.credited_amount_cents ?? record.usd_credit_amount,
          new_balance: result?.new_balance,
          already_processed: result?.already_processed ?? false,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    } else if (gatewayStatus === 'failed' || gatewayStatus === 'abandoned') {
      await supabaseAdmin.rpc('credit_verified_payment', {
        p_reference: reference,
        p_gateway_status: gatewayStatus,
        p_metadata: gatewayMeta,
      })

      return new Response(
        JSON.stringify({
          status: gatewayStatus,
          reference,
          message: 'Payment was not successful',
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      )
    }

    return new Response(
      JSON.stringify({
        status: gatewayStatus || 'pending',
        reference,
        message: 'Payment is awaiting completion',
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  } catch (error) {
    console.error('Unexpected error in verify-payment:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    )
  }
})
