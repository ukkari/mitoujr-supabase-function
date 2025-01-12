// supabase/functions/_shared/cors.ts
export function corsHeaders() {
    return {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, X-Requested-With, Content-Type, Accept, Origin',
      'Access-Control-Allow-Methods': 'GET, OPTIONS, POST'
    }
  }
  