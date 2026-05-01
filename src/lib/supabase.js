import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null

export async function fetchTodayStats() {
  if (!supabase) return null
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase
    .from('daily_stats')
    .select('*')
    .lte('date', today)
    .order('date', { ascending: false })
    .limit(1)
    .single()
  return data
}

export async function fetchConnections() {
  if (!supabase) return null
  const { data } = await supabase
    .from('athlete_profile')
    .select('garmin_connected, oura_connected, whoop_connected')
    .eq('id', 1)
    .single()
  return data
}
