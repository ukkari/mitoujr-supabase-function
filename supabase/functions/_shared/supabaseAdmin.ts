// supabase/functions/_shared/supabaseAdmin.ts
import { createClient } from 'supabase-js'

export const supabaseAdmin = createClient(
  // 環境変数から読み込み
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '' // SERVICE_ROLE
)
