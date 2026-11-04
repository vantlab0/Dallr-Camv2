// supabase/functions/paystack-webhook/index.ts
// Secure Paystack webhook receiver.
// 1. Verifies HMAC-SHA512 Paystack signature against the raw body using PAYSTACK_SECRET_KEY.
// 2. Independently queries Paystack API to verify transaction status, currency, amount, and reference.
// 3. Atomically and idempotently credits the USD wallet via credit_verified_payment.
// 4. Handles delayed webhooks, failed/abandoned payments, and prevents duplicate credits.
// All mock fallbacks are strictly prohibited. Missing or invalid signatures reject with HTTP 401.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

async function verifyHmacSha512(secret: string, body: string, signature: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['verify', 'sign']
    )
    const computedSignatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
    const hashArray = Array.from(new Uint8Array(computedSignatureBuffer))
    const computedHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')

    const cleanSig = signature.trim().toLowerCase()
    const cleanComputed = computedHex.toLowerCase()

    if (cleanSig.length !== cleanComputed.length) {
      return false
    }

    // Constant-time comparison to prevent timing attacks
    let diff = 0
    for (let i = 0; i < cleanComputed.length; i++) {
      diff |= cleanComputed.charCodeAt(i) ^ cleanSig.charCodeAt(i)
    }
    return diff === 0
  } catch (err) {
    console.error('Error verifying HMAC signature:', err)
    return false
  }
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY') || ''
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

    // Missing secret credentials must immediately cause secure failure
    if (!paystackSecretKey) {
      console.error('PAYSTACK_SECRET_KEY environment variable is not configured')
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Supabase credentials are not configured')
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const rawBody = await req.text()
    const paystackSignature = req.headers.get('x-paystack-signature')

    // 1. Signature Verification: strictly require valid HMAC-SHA512
    if (!paystackSignature) {
      console.warn('Webhook rejected: Missing x-paystack-signature header')
      return new Response('Missing Paystack signature', { status: 401 })
    }

    const isValidSignature = await verifyHmacSha512(paystackSecretKey, rawBody, paystackSignature)
    if (!isValidSignature) {
      console.warn('Webhook rejected: Invalid Paystack signature')
      return new Response('Invalid Paystack signature', { status: 401 })
    }

    let event: Record<string, any>
    try {
      event = JSON.parse(rawBody)
    } catch {
      return new Response('Malformed JSON payload', { status: 400 })
    }

    const eventType = event.event
    const data = event.data

    if (!data || !data.reference) {
      return new Response('Missing transaction reference', { status: 400 })
    }

    const reference = String(data.reference).trim()
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    // Lookup payment record
    const { data: record, error: recordError } = await supabaseAdmin
      .from('payment_records')
      .select('*')
      .eq('reference', reference)
      .maybeSingle()

    if (recordError || !record) {
      console.error('Payment record not found for webhook reference:', reference)
      return new Response(JSON.stringify({ error: 'Payment record not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // If already marked as success, return 200 OK idempotently
    if (record.status === 'success') {
      return new Response(
        JSON.stringify({ status: 'ok', message: 'Payment already processed' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    }

    // 2. Handle relevant event types
    if (eventType === 'charge.success') {
      // Independent Paystack API verification is strictly required
      const verifyRes = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${paystackSecretKey}`,
          },
        }
      )
      const verifyData = await verifyRes.json()

      if (!verifyRes.ok || !verifyData.status) {
        console.error('Independent verification failed with Paystack API:', verifyData)
        return new Response(
          JSON.stringify({ error: 'Gateway verification inquiry failed' }),
          {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      const verifiedDetails = verifyData.data
      const verifiedStatus = verifiedDetails?.status // 'success' | 'failed' | 'abandoned'
      const verifiedAmount = verifiedDetails?.amount
      const verifiedCurrency = verifiedDetails?.currency
      const verifiedReference = verifiedDetails?.reference

      // Integrity checks
      if (
        verifiedStatus !== 'success' ||
        verifiedReference !== reference ||
        verifiedCurrency !== 'NGN' ||
        Number(verifiedAmount) !== Number(record.ngn_amount)
      ) {
        console.error('Integrity check failed for webhook transaction:', {
          verifiedStatus,
          verifiedReference,
          reference,
          verifiedCurrency,
          verifiedAmount,
          expectedAmount: record.ngn_amount,
        })

        // Record as failed, never credit wallet
        await supabaseAdmin.rpc('credit_verified_payment', {
          p_reference: reference,
          p_gateway_status: 'failed',
          p_metadata: {
            webhook_event: eventType,
            reason: 'Integrity check failed during verification',
            verified_amount: verifiedAmount,
            verified_currency: verifiedCurrency,
          },
        })

        return new Response(
          JSON.stringify({ error: 'Transaction validation failed' }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }

      // 3. Atomically & idempotently credit the wallet via database stored procedure
      const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
        'credit_verified_payment',
        {
          p_reference: reference,
          p_gateway_status: 'success',
          p_metadata: {
            webhook_event: eventType,
            gateway_response: verifiedDetails.gateway_response || null,
            paid_at: verifiedDetails.paid_at || new Date().toISOString(),
            raw_event_id: event.id || null,
            channel: verifiedDetails.channel || null,
          },
        }
      )

      if (rpcError) {
        console.error('Failed to credit verified payment:', rpcError)
        return new Response(JSON.stringify({ error: rpcError.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(
        JSON.stringify({
          status: 'ok',
          result: rpcData,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    } else if (
      eventType === 'charge.failed' ||
      eventType === 'paymentrequest.failed' ||
      eventType === 'subscription.expiring_cards'
    ) {
      // Record failed payment - never credits wallet
      await supabaseAdmin.rpc('credit_verified_payment', {
        p_reference: reference,
        p_gateway_status: 'failed',
        p_metadata: {
          webhook_event: eventType,
          gateway_response: data.gateway_response || 'Failed',
        },
      })

      return new Response(JSON.stringify({ status: 'recorded_failed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ status: 'ignored_event' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Webhook processing error:', error)
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Webhook error' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    )
  }
})
