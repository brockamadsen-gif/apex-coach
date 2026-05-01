import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const secret = req.headers['x-webhook-secret']
  if (process.env.COMPOSIO_WEBHOOK_SECRET && secret !== process.env.COMPOSIO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { trigger_name, payload } = req.body

  try {
    if (trigger_name?.toLowerCase().includes('garmin')) {
      await handleGarmin(payload)
    } else if (trigger_name?.toLowerCase().includes('oura')) {
      await handleOura(payload)
    } else if (trigger_name?.toLowerCase().includes('whoop')) {
      await handleWhoop(payload)
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('Webhook error:', e)
    res.status(500).json({ error: e.message })
  }
}

async function handleGarmin(p) {
  const date = p.calendarDate || new Date().toISOString().split('T')[0]
  await supabase.from('daily_stats').upsert({
    date,
    hrv_ms: p.lastNight5MinHighHrv ?? p.hrvStatus?.lastNight5MinHighHrv ?? null,
    resting_hr: p.restingHeartRateInBeatsPerMinute ?? null,
    body_battery: p.bodyBatteryHighestValue ?? null,
    vo2max: p.vo2MaxPreciseValue ?? null,
    source: 'garmin',
    raw: p,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'date' })

  await supabase.from('athlete_profile').upsert(
    { id: 1, garmin_connected: true, updated_at: new Date().toISOString() },
    { onConflict: 'id' }
  )
}

async function handleOura(p) {
  const date = p.day || new Date().toISOString().split('T')[0]
  const sleepSecs = p.contributors?.total_sleep
  await supabase.from('daily_stats').upsert({
    date,
    hrv_ms: p.contributors?.hrv_balance ?? null,
    recovery_score: p.score ?? null,
    sleep_hours: sleepSecs ? Math.round((sleepSecs / 3600) * 10) / 10 : null,
    source: 'oura',
    raw: p,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'date' })

  await supabase.from('athlete_profile').upsert(
    { id: 1, oura_connected: true, updated_at: new Date().toISOString() },
    { onConflict: 'id' }
  )
}

async function handleWhoop(p) {
  const date = p.start ? p.start.split('T')[0] : new Date().toISOString().split('T')[0]
  await supabase.from('daily_stats').upsert({
    date,
    hrv_ms: p.score?.hrv_rmssd_milli ? Math.round(p.score.hrv_rmssd_milli) : null,
    resting_hr: p.score?.resting_heart_rate ?? null,
    recovery_score: p.score?.recovery_score ?? null,
    source: 'whoop',
    raw: p,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'date' })

  await supabase.from('athlete_profile').upsert(
    { id: 1, whoop_connected: true, updated_at: new Date().toISOString() },
    { onConflict: 'id' }
  )
}
