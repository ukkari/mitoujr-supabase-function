// supabase/functions/_shared/supabaseClient.ts
import { createClient } from 'supabase-js'

export const supabaseClient = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_ANON_KEY') ?? ''
)
