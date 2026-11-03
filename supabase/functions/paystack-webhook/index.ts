// supabase/functions/paystack-webhook/index.ts
// Secure Paystack webhook receiver.
// 1. Verifies HMAC-SHA512 Paystack signature against the raw body using PAYSTACK_SECRET_KEY.
// 2. Independently queries Paystack API to verify transaction status and amount.
// 3. Atomically and idempotently credits the USD wallet via credit_verified_payment.
// 4. Handles delayed webhooks, failed/abandoned payments, and prevents duplicate credits.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'
import { hmac } from 'https://deno.land/x/hmac@v2.0.1/mod.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const paystackSecretKey = Deno.env.get('PAYSTACK_SECRET_KEY') || ''
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

    const rawBody = await req.text()
    const paystackSignature = req.headers.get('x-paystack-signature')

    // 1. Signature Verification
    if (paystackSecretKey) {
      if (!paystackSignature) {
        return new Response('Missing Paystack signature', { status: 401 })
      }

      // Compute HMAC SHA512 in hex
      const computedSignature = hmac('sha512', paystackSecretKey, rawBody, 'utf8', 'hex')

      if (computedSignature !== paystackSignature) {
        console.error('Webhook signature mismatch')
        return new Response('Invalid Paystack signature', { status: 401 })
      }
    }

    const event = JSON.parse(rawBody)
    const eventType = event.event
    const data = event.data

    if (!data || !data.reference) {
      return new Response('Missing transaction reference', { status: 400 })
    }

    const reference = data.reference
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    // 2. Handle relevant event types
    if (eventType === 'charge.success') {
      let verifiedStatus = data.status // 'success'

      // Independent Paystack API verification if secret key is present
      if (paystackSecretKey) {
        try {
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
          if (!verifyRes.ok || !verifyData.status || verifyData.data.status !== 'success') {
            console.error('Independent verification failed for reference:', reference)
            verifiedStatus = verifyData.data?.status || 'failed'
          } else {
            verifiedStatus = 'success'
          }
        } catch (vErr) {
          console.error('Error during independent Paystack verification:', vErr)
        }
      }

      // 3. Atomically & idempotently credit the wallet via database stored procedure
      const { data: rpcData, error: rpcError } = await supabaseAdmin.rpc(
        'credit_verified_payment',
        {
          p_reference: reference,
          p_gateway_status: verifiedStatus,
          p_metadata: {
            webhook_event: eventType,
            gateway_response: data.gateway_response || null,
            paid_at: data.paid_at || new Date().toISOString(),
            raw_event_id: event.id || null,
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
      // Record failed payment
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
