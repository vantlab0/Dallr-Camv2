// supabase/functions/get-exchange-rate/index.ts
// Trusted exchange rate provider for Dallr Cam
// Returns the authoritative backend-controlled USD to NGN rate and payment constraints.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const configuredRate = Number(Deno.env.get('PAYSTACK_USD_TO_NGN_RATE') || '1550')
    const minimumTopUpUSD = 15
    const liveUsageRatePerSecondUSD = 0.04

    return new Response(
      JSON.stringify({
        usd_to_ngn_rate: configuredRate,
        wallet_currency: 'USD',
        payment_currency: 'NGN',
        minimum_top_up_usd: minimumTopUpUSD,
        live_usage_rate_per_second_usd: liveUsageRatePerSecondUSD,
        updated_at: new Date().toISOString(),
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal Server Error' }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    )
  }
})
