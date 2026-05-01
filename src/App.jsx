import { useState, useRef, useEffect, useCallback } from 'react'

// ─── Strava integration ───────────────────────────────────────────────────────

const STRAVA_CLIENT_ID = import.meta.env.VITE_STRAVA_CLIENT_ID
const STRAVA_CLIENT_SECRET = import.meta.env.VITE_STRAVA_CLIENT_SECRET

function stravaAuthUrl() {
  const redirect = window.location.origin + window.location.pathname
  return `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=activity:read_all,read`
}

async function stravaExchangeToken(code) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Strava token exchange failed: ${res.status}`)
  return res.json()
}

async function stravaRefreshToken(refreshToken) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error('Strava token refresh failed')
  return res.json()
}

async function stravaGetValidToken() {
  const stored = JSON.parse(localStorage.getItem('strava_token') || 'null')
  if (!stored) return null
  if (Date.now() / 1000 < stored.expires_at - 300) return stored.access_token
  const refreshed = await stravaRefreshToken(stored.refresh_token)
  const updated = { ...stored, ...refreshed }
  localStorage.setItem('strava_token', JSON.stringify(updated))
  return updated.access_token
}

async function stravaFetchAthlete(token) {
  const res = await fetch('https://www.strava.com/api/v3/athlete', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Failed to fetch athlete')
  return res.json()
}

async function stravaFetchActivities(token, perPage = 20) {
  const res = await fetch(`https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Failed to fetch activities')
  return res.json()
}

function mapStravaRun(activity) {
  const distMiles = activity.distance / 1609.34
  const paceSec = distMiles > 0 ? activity.moving_time / distMiles : 0
  const paceMin = Math.floor(paceSec / 60)
  const paceSecs = Math.round(paceSec % 60)
  const d = new Date(activity.start_date_local)
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  let type = 'Easy'
  if (activity.workout_type === 1) type = 'Race'
  else if (activity.workout_type === 2) type = 'Long Run'
  else if (activity.workout_type === 3) type = 'Tempo'
  else if (distMiles >= 12) type = 'Long Run'
  else if ((activity.average_heartrate || 0) > 158) type = 'Tempo'

  return {
    date: dateStr,
    type,
    distance: Math.round(distMiles * 10) / 10,
    pace: `${paceMin}:${paceSecs.toString().padStart(2, '0')}`,
    avgHR: Math.round(activity.average_heartrate || 0),
    name: activity.name,
  }
}

function computeWeeklyMiles(activities) {
  const now = new Date()
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - now.getDay())
  weekStart.setHours(0, 0, 0, 0)
  const prevWeekStart = new Date(weekStart)
  prevWeekStart.setDate(prevWeekStart.getDate() - 7)

  const runs = activities.filter(a => a.sport_type === 'Run' || a.type === 'Run')
  const thisWeek = runs
    .filter(a => new Date(a.start_date_local) >= weekStart)
    .reduce((s, a) => s + a.distance / 1609.34, 0)
  const lastWeek = runs
    .filter(a => {
      const d = new Date(a.start_date_local)
      return d >= prevWeekStart && d < weekStart
    })
    .reduce((s, a) => s + a.distance / 1609.34, 0)

  const diff = thisWeek - lastWeek
  const trend = diff >= 0 ? `+${diff.toFixed(1)} mi vs last week` : `${diff.toFixed(1)} mi vs last week`
  return { totalMiles: Math.round(thisWeek * 10) / 10, trend }
}

// ─── Mock athlete data (fallback when not connected) ─────────────────────────

const ATHLETE_BASE = {
  name: 'Athlete',
  goal: 'Sub-3:30 Marathon',
  nextRace: 'Chicago Marathon',
  raceDate: '2026-10-11',
  weeklyMileage: 0,
  trainingDays: 5,
  vo2max: '—',
  restingHR: '—',
  hrv: '—',
  recoveryScore: '—',
  avgSleep: '—',
  connectedApps: [],
  recentRuns: [],
}

const WEEKLY_BASE = {
  totalMiles: 0,
  targetMiles: 48,
  qualityRuns: 0,
  easyRuns: 0,
  loadStatus: 'normal',
  trend: '—',
}

// ─── Training plans ───────────────────────────────────────────────────────────

const PLANS = [
  {
    id: 'marathon',
    name: 'Sub-3:30 Marathon',
    badge: 'Recommended',
    weeks: 16,
    peakMiles: 55,
    model: 'Polarized — 80% easy, 20% quality',
    keyWorkouts: ['Weekly tempo 6–8mi', 'Long run 16–20mi', '2× speed sessions/week'],
    bestFor: 'Runners with a 40+ mpw base targeting their first or PR marathon',
    color: 'accent',
  },
  {
    id: 'half',
    name: 'Half Marathon PR',
    badge: null,
    weeks: 10,
    peakMiles: 45,
    model: 'High-intensity lactate threshold block',
    keyWorkouts: ['Race-pace intervals', 'Threshold cruise runs', 'Strides 2×/week'],
    bestFor: 'Locking in a PR before a longer marathon training cycle',
    color: 'blue',
  },
  {
    id: 'base',
    name: 'Aerobic Base Block',
    badge: null,
    weeks: 8,
    peakMiles: 50,
    model: 'All easy effort, zero structured workouts',
    keyWorkouts: ['Daily easy runs', 'Weekend long run', 'Optional strides'],
    bestFor: 'Reducing injury risk before entering a harder training block',
    color: 'orange',
  },
]

// ─── Goals ────────────────────────────────────────────────────────────────────

const PRESET_GOALS = [
  { id: 'sub330', label: 'Sub-3:30 Marathon', icon: '🏆' },
  { id: 'sub2hr', label: 'Sub-2:00 Half Marathon', icon: '⚡' },
  { id: 'base', label: 'Build Aerobic Base', icon: '🧱' },
  { id: 'weight', label: 'Lose 10 lbs', icon: '⚖️' },
  { id: 'streak', label: 'Run 30 Days Straight', icon: '🔥' },
  { id: 'firsthalf', label: 'First Half Marathon', icon: '🎯' },
]

// ─── Claude context builder ───────────────────────────────────────────────────

function buildCoachContext(athlete, weekly, goal) {
  const runs = athlete.recentRuns.length
    ? athlete.recentRuns.map(r => `- ${r.date}: ${r.type}, ${r.distance} mi @ ${r.pace}/mi${r.avgHR ? `, avg HR ${r.avgHR} bpm` : ''}${r.name ? ` (${r.name})` : ''}`).join('\n')
    : '- No runs synced yet'

  return `You are Apex Coach, an expert AI running and fitness coach. You have full access to this athlete's training data. Always give specific, empirical advice based on their actual numbers — never generic advice.

ATHLETE PROFILE:
- Name: ${athlete.name}
- Current Goal: ${goal || athlete.goal}
- Next Race: ${athlete.nextRace} on ${athlete.raceDate}
- Weekly Mileage: ${weekly.totalMiles} mi this week (target: ${weekly.targetMiles} mi/wk)
- Training Days: ${athlete.trainingDays}/week
- VO2 Max: ${athlete.vo2max}
- Resting HR: ${athlete.restingHR}
- HRV: ${athlete.hrv}
- Recovery Score: ${athlete.recoveryScore}
- Avg Sleep: ${athlete.avgSleep} hours
- Connected Apps: ${athlete.connectedApps.length ? athlete.connectedApps.join(', ') : 'None connected yet'}

LAST ${athlete.recentRuns.length || 0} RUNS:
${runs}

CURRENT WEEK:
- Total: ${weekly.totalMiles} mi
- Trend: ${weekly.trend}

Always reference specific data points. Be direct and concise. Flag concerns clearly.`
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function callClaude(messages, systemPrompt) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_KEY
  if (!apiKey) throw new Error('VITE_ANTHROPIC_KEY not set')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `API error ${res.status}`)
  }
  const data = await res.json()
  return data.content[0].text
}

// ─── Components ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, unit, sub, color = 'default' }) {
  const colorMap = {
    default: { border: '#2a2a2a', accent: '#a0a0a0' },
    green: { border: 'rgba(200,251,87,0.3)', accent: '#c8fb57' },
    red: { border: 'rgba(255,91,91,0.3)', accent: '#ff5b5b' },
    blue: { border: 'rgba(91,157,255,0.3)', accent: '#5b9dff' },
    orange: { border: 'rgba(255,154,60,0.3)', accent: '#ff9a3c' },
  }
  const c = colorMap[color]
  const empty = value === '—' || value === undefined

  return (
    <div style={{
      background: '#141414',
      border: `1px solid ${c.border}`,
      borderRadius: 12,
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    }}>
      <div style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 28, fontWeight: 600, color: empty ? '#333' : c.accent, lineHeight: 1 }}>{value ?? '—'}</span>
        {unit && !empty && <span style={{ fontSize: 13, color: '#666' }}>{unit}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: '#555' }}>{sub}</div>}
    </div>
  )
}

function RunRow({ run }) {
  const typeColor = {
    'Easy': '#5b9dff',
    'Tempo': '#c8fb57',
    'Long Run': '#ff9a3c',
    'Race': '#ff5b5b',
    'Speed': '#ff5b5b',
  }
  const c = typeColor[run.type] || '#a0a0a0'

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '12px 16px',
      borderBottom: '1px solid #1e1e1e',
    }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#f0f0f0', fontWeight: 500, fontSize: 14 }}>{run.type}</span>
          <span style={{ fontSize: 12, color: '#555' }}>{run.date}</span>
        </div>
        <div style={{ fontSize: 13, color: '#666', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.distance} mi · {run.pace}/mi{run.avgHR ? ` · ${run.avgHR} bpm` : ''}
          {run.name ? ` · ${run.name}` : ''}
        </div>
      </div>
    </div>
  )
}

// ─── Connection card ──────────────────────────────────────────────────────────

function ConnectionCard({ name, icon, description, connected, onConnect, onDisconnect, comingSoon }) {
  return (
    <div style={{
      background: '#141414',
      border: `1px solid ${connected ? 'rgba(200,251,87,0.25)' : '#2a2a2a'}`,
      borderRadius: 12,
      padding: '14px 16px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{
        width: 40, height: 40, borderRadius: 10,
        background: connected ? 'rgba(200,251,87,0.1)' : '#1e1e1e',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 20, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f0f0' }}>{name}</div>
        <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{description}</div>
      </div>
      {comingSoon ? (
        <div style={{ fontSize: 11, color: '#555', border: '1px solid #2a2a2a', borderRadius: 6, padding: '4px 8px', flexShrink: 0 }}>
          Soon
        </div>
      ) : connected ? (
        <button
          onClick={onDisconnect}
          style={{
            fontSize: 12, color: '#c8fb57', background: 'rgba(200,251,87,0.1)',
            border: '1px solid rgba(200,251,87,0.2)', borderRadius: 8,
            padding: '6px 12px', cursor: 'pointer', flexShrink: 0,
          }}
        >
          Connected ✓
        </button>
      ) : (
        <button
          onClick={onConnect}
          style={{
            fontSize: 12, color: '#f0f0f0', background: '#222',
            border: '1px solid #333', borderRadius: 8,
            padding: '6px 12px', cursor: 'pointer', flexShrink: 0,
          }}
        >
          Connect
        </button>
      )}
    </div>
  )
}

// ─── Dashboard screen ─────────────────────────────────────────────────────────

function Dashboard({ athlete, weekly, onAskCoach, stravaConnected, onConnectStrava, onDisconnectStrava, loading }) {
  const pct = weekly.targetMiles > 0 ? Math.round((weekly.totalMiles / weekly.targetMiles) * 100) : 0
  const hasRuns = athlete.recentRuns.length > 0

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div>
        <div style={{ fontSize: 13, color: '#666' }}>Good morning</div>
        <div style={{ fontSize: 22, fontWeight: 600, color: '#f0f0f0', marginTop: 2 }}>
          {athlete.name === 'Athlete' ? 'Your Training' : `${athlete.name}'s Training`}
        </div>
        <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>{athlete.goal} · {athlete.nextRace}</div>
      </div>

      {/* Connect prompt (shown when not connected) */}
      {!stravaConnected && (
        <div style={{
          background: 'rgba(91,157,255,0.06)',
          border: '1px solid rgba(91,157,255,0.2)',
          borderRadius: 12, padding: '14px 16px',
          display: 'flex', gap: 12, alignItems: 'flex-start',
        }}>
          <div style={{ fontSize: 20, lineHeight: 1 }}>📡</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#5b9dff', marginBottom: 4 }}>Connect your apps</div>
            <div style={{ fontSize: 13, color: '#a0a0a0', lineHeight: 1.5 }}>
              Link Strava to load your real runs, pace, and weekly mileage into the coach's context.
            </div>
            <button
              onClick={onConnectStrava}
              disabled={!STRAVA_CLIENT_ID}
              style={{
                marginTop: 10, background: STRAVA_CLIENT_ID ? '#fc4c02' : '#222',
                color: '#fff', border: 'none', borderRadius: 8,
                padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: STRAVA_CLIENT_ID ? 'pointer' : 'default',
              }}
            >
              {STRAVA_CLIENT_ID ? 'Connect Strava' : 'Add VITE_STRAVA_CLIENT_ID to .env.local'}
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div style={{
          background: '#141414', border: '1px solid #2a2a2a',
          borderRadius: 12, padding: '14px 16px',
          fontSize: 13, color: '#666', display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #555', borderTopColor: '#c8fb57', animation: 'spin 0.8s linear infinite' }} />
          Syncing Strava data...
        </div>
      )}

      {/* Coach nudge (when connected) */}
      {stravaConnected && hasRuns && (
        <div style={{
          background: 'rgba(200,251,87,0.06)',
          border: '1px solid rgba(200,251,87,0.2)',
          borderRadius: 12, padding: '14px 16px',
          display: 'flex', gap: 12, alignItems: 'flex-start',
        }}>
          <div style={{ fontSize: 20, lineHeight: 1 }}>🤖</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#c8fb57', marginBottom: 4 }}>Coach Nudge</div>
            <div style={{ fontSize: 13, color: '#a0a0a0', lineHeight: 1.5 }}>
              Your last run: {athlete.recentRuns[0]?.distance} mi {athlete.recentRuns[0]?.type.toLowerCase()} at {athlete.recentRuns[0]?.pace}/mi.{' '}
              This week: {weekly.totalMiles} mi. Ask your coach what's next.
            </div>
            <button
              onClick={() => onAskCoach('Based on my most recent run and this week\'s training load, what should I do today?')}
              style={{
                marginTop: 10, background: 'rgba(200,251,87,0.12)',
                color: '#c8fb57', border: '1px solid rgba(200,251,87,0.25)',
                borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
              }}
            >
              Ask coach →
            </button>
          </div>
        </div>
      )}

      {/* Weekly progress */}
      <div style={{ background: '#141414', border: '1px solid #2a2a2a', borderRadius: 12, padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f0f0f0' }}>Weekly Mileage</div>
          <div style={{ fontSize: 13, color: '#666' }}>{weekly.trend}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 12 }}>
          <span style={{ fontSize: 32, fontWeight: 700, color: stravaConnected ? '#c8fb57' : '#333' }}>{weekly.totalMiles}</span>
          <span style={{ fontSize: 14, color: '#555' }}>/ {weekly.targetMiles} mi target</span>
        </div>
        <div style={{ background: '#1e1e1e', borderRadius: 4, height: 6, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 4,
            width: `${Math.min(pct, 100)}%`,
            background: pct >= 90 ? '#ff5b5b' : '#c8fb57',
            transition: 'width 0.5s ease',
          }} />
        </div>
        <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>
          {stravaConnected ? `${pct}% of weekly target` : 'Connect Strava to track real mileage'}
        </div>
      </div>

      {/* Metric grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <MetricCard label="VO2 Max" value={athlete.vo2max} unit={athlete.vo2max !== '—' ? 'ml/kg/min' : undefined} sub="via Garmin" color={athlete.vo2max !== '—' ? 'green' : 'default'} />
        <MetricCard label="HRV" value={athlete.hrv} unit={athlete.hrv !== '—' ? 'ms' : undefined} sub="via Garmin/Oura" color={athlete.hrv !== '—' ? 'green' : 'default'} />
        <MetricCard label="Recovery" value={athlete.recoveryScore} unit={athlete.recoveryScore !== '—' ? '/100' : undefined} sub="via Oura/WHOOP" color={typeof athlete.recoveryScore === 'number' ? (athlete.recoveryScore >= 70 ? 'green' : athlete.recoveryScore >= 50 ? 'orange' : 'red') : 'default'} />
        <MetricCard label="Avg Sleep" value={athlete.avgSleep} unit={athlete.avgSleep !== '—' ? 'hrs' : undefined} sub="via Oura" color={athlete.avgSleep !== '—' ? 'blue' : 'default'} />
        <MetricCard label="Resting HR" value={athlete.restingHR} unit={athlete.restingHR !== '—' ? 'bpm' : undefined} color={athlete.restingHR !== '—' ? 'blue' : 'default'} />
        <MetricCard label="This Week" value={weekly.totalMiles} unit="mi" color={stravaConnected ? 'green' : 'default'} />
      </div>

      {/* Recent runs */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#f0f0f0' }}>Recent Runs</div>
          {stravaConnected && (
            <div style={{ fontSize: 11, color: '#c8fb57' }}>● Live from Strava</div>
          )}
        </div>
        <div style={{ background: '#141414', border: '1px solid #2a2a2a', borderRadius: 12, overflow: 'hidden' }}>
          {hasRuns ? (
            athlete.recentRuns.slice(0, 5).map((run, i) => <RunRow key={i} run={run} />)
          ) : (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: '#444', fontSize: 13 }}>
              {stravaConnected ? 'No runs found in Strava' : 'Connect Strava to see your runs'}
            </div>
          )}
        </div>
      </div>

      {/* Connected apps */}
      {athlete.connectedApps.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {athlete.connectedApps.map(app => (
            <div key={app} style={{
              fontSize: 12, color: '#c8fb57',
              background: 'rgba(200,251,87,0.08)',
              border: '1px solid rgba(200,251,87,0.2)',
              borderRadius: 20, padding: '4px 10px',
            }}>
              ● {app}
            </div>
          ))}
        </div>
      )}

      {/* Connections section */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#f0f0f0', marginBottom: 10 }}>Connections</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ConnectionCard
            name="Strava"
            icon="🏃"
            description="Runs, pace, heart rate, weekly mileage"
            connected={stravaConnected}
            onConnect={onConnectStrava}
            onDisconnect={onDisconnectStrava}
          />
          <ConnectionCard
            name="Garmin Connect"
            icon="⌚"
            description="VO2 max, Body Battery, GPS splits — requires Composio setup"
            connected={false}
            comingSoon={true}
          />
          <ConnectionCard
            name="Oura Ring"
            icon="💍"
            description="HRV, sleep stages, recovery score — requires Composio setup"
            connected={false}
            comingSoon={true}
          />
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// ─── Coach screen ─────────────────────────────────────────────────────────────

function Coach({ initialMessage, athlete, weekly, goal }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)
  const sentInitial = useRef(false)

  const systemPrompt = buildCoachContext(athlete, weekly, goal)

  const send = useCallback(async (text) => {
    const content = text.trim()
    if (!content || loading) return

    const userMsg = { role: 'user', content }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)
    setError(null)

    try {
      const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
      const reply = await callClaude(history, systemPrompt)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [loading, messages, systemPrompt])

  useEffect(() => {
    if (initialMessage && !sentInitial.current) {
      sentInitial.current = true
      send(initialMessage)
    }
  }, [initialMessage, send])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const QUICK = [
    'How was my last run?',
    'Am I recovered enough for a hard effort tomorrow?',
    'What pace should my long run be?',
    'How does my training load look this week?',
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {messages.length === 0 && !loading && (
          <div style={{ padding: '20px 0' }}>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>🤖</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: '#f0f0f0' }}>Apex Coach</div>
              <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
                {athlete.recentRuns.length > 0
                  ? `Loaded ${athlete.recentRuns.length} recent runs from Strava. Ask me anything.`
                  : 'Your data is loaded. Ask me anything about your training.'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {QUICK.map(q => (
                <button
                  key={q}
                  onClick={() => send(q)}
                  style={{
                    background: '#141414', border: '1px solid #2a2a2a',
                    borderRadius: 10, padding: '12px 14px', textAlign: 'left',
                    color: '#a0a0a0', fontSize: 13, cursor: 'pointer',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#3a3a3a'; e.currentTarget.style.color = '#f0f0f0' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#2a2a2a'; e.currentTarget.style.color = '#a0a0a0' }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{
            marginBottom: 16,
            display: 'flex',
            flexDirection: m.role === 'user' ? 'row-reverse' : 'row',
            gap: 10, alignItems: 'flex-start',
          }}>
            {m.role === 'assistant' && (
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: 'rgba(200,251,87,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, flexShrink: 0, marginTop: 2,
              }}>🤖</div>
            )}
            <div style={{
              maxWidth: '80%',
              background: m.role === 'user' ? 'rgba(200,251,87,0.1)' : '#141414',
              border: m.role === 'user' ? '1px solid rgba(200,251,87,0.2)' : '1px solid #2a2a2a',
              borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
              padding: '12px 14px', fontSize: 14, lineHeight: 1.55,
              color: m.role === 'user' ? '#c8fb57' : '#d0d0d0',
              whiteSpace: 'pre-wrap',
            }}>
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 16 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'rgba(200,251,87,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, flexShrink: 0,
            }}>🤖</div>
            <div style={{
              background: '#141414', border: '1px solid #2a2a2a',
              borderRadius: '16px 16px 16px 4px', padding: '14px 16px',
              display: 'flex', gap: 5, alignItems: 'center',
            }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: 6, height: 6, borderRadius: '50%', background: '#555',
                  animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: 'rgba(255,91,91,0.1)', border: '1px solid rgba(255,91,91,0.3)',
            borderRadius: 10, padding: '10px 14px', fontSize: 13, color: '#ff5b5b', marginBottom: 12,
          }}>
            Error: {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid #1e1e1e' }}>
        <div style={{
          display: 'flex', gap: 8, alignItems: 'flex-end',
          background: '#141414', border: '1px solid #2a2a2a',
          borderRadius: 14, padding: '10px 10px 10px 14px',
        }}>
          <textarea
            value={input}
            onChange={e => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
            }}
            placeholder="Ask your coach..."
            rows={1}
            style={{
              flex: 1, background: 'transparent', border: 'none',
              color: '#f0f0f0', fontSize: 14, resize: 'none',
              lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
            }}
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || loading}
            style={{
              width: 34, height: 34, borderRadius: 10, flexShrink: 0,
              background: input.trim() && !loading ? '#c8fb57' : '#222',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: input.trim() && !loading ? 'pointer' : 'default',
              border: 'none',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M22 2L11 13" stroke={input.trim() && !loading ? '#0a0a0a' : '#555'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke={input.trim() && !loading ? '#0a0a0a' : '#555'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#444', textAlign: 'center', marginTop: 6 }}>Return to send · Shift+Return for new line</div>
      </div>

      <style>{`
        @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }
      `}</style>
    </div>
  )
}

// ─── Plans screen ─────────────────────────────────────────────────────────────

function Plans({ activePlan, setActivePlan }) {
  const colorMap = {
    accent: { border: 'rgba(200,251,87,0.3)', text: '#c8fb57', bg: 'rgba(200,251,87,0.06)' },
    blue: { border: 'rgba(91,157,255,0.3)', text: '#5b9dff', bg: 'rgba(91,157,255,0.06)' },
    orange: { border: 'rgba(255,154,60,0.3)', text: '#ff9a3c', bg: 'rgba(255,154,60,0.06)' },
  }

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#f0f0f0' }}>Training Plans</div>
        <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Matched to your current fitness and goal</div>
      </div>

      {PLANS.map(plan => {
        const c = colorMap[plan.color]
        const isActive = activePlan === plan.id

        return (
          <div
            key={plan.id}
            onClick={() => setActivePlan(isActive ? null : plan.id)}
            style={{
              background: isActive ? c.bg : '#141414',
              border: `1px solid ${isActive ? c.border : '#2a2a2a'}`,
              borderRadius: 14, padding: '18px 20px', cursor: 'pointer',
              transition: 'all 0.2s',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#f0f0f0' }}>{plan.name}</span>
                  {plan.badge && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: c.text,
                      background: c.bg, border: `1px solid ${c.border}`,
                      borderRadius: 20, padding: '2px 8px', letterSpacing: '0.05em',
                    }}>{plan.badge}</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#555' }}>{plan.weeks} weeks · Peak {plan.peakMiles} mi/wk</div>
              </div>
              <div style={{
                width: 24, height: 24, borderRadius: '50%',
                border: `2px solid ${isActive ? c.text : '#333'}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                {isActive && <div style={{ width: 10, height: 10, borderRadius: '50%', background: c.text }} />}
              </div>
            </div>

            {isActive && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: '#555', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Model</div>
                <div style={{ fontSize: 13, color: '#a0a0a0', marginBottom: 14 }}>{plan.model}</div>
                <div style={{ fontSize: 12, color: '#555', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Key Workouts</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                  {plan.keyWorkouts.map(w => (
                    <div key={w} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <div style={{ width: 4, height: 4, borderRadius: '50%', background: c.text, flexShrink: 0, marginTop: 7 }} />
                      <span style={{ fontSize: 13, color: '#a0a0a0' }}>{w}</span>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 12, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Best For</div>
                <div style={{ fontSize: 13, color: '#a0a0a0' }}>{plan.bestFor}</div>
                <button style={{
                  marginTop: 16, width: '100%', padding: '12px',
                  background: c.text, color: '#0a0a0a', borderRadius: 10,
                  fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer',
                }}>
                  Start This Plan
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Goals screen ─────────────────────────────────────────────────────────────

function Goals({ goal, setGoal }) {
  const [custom, setCustom] = useState('')
  const [editing, setEditing] = useState(false)

  const handleSelect = (label) => { setGoal(label); setEditing(false); setCustom('') }
  const handleCustomSubmit = () => { if (custom.trim()) { setGoal(custom.trim()); setCustom(''); setEditing(false) } }

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 600, color: '#f0f0f0' }}>Your Goal</div>
        <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Sets the context for all coach responses</div>
      </div>

      {goal && (
        <div style={{
          background: 'rgba(200,251,87,0.06)',
          border: '1px solid rgba(200,251,87,0.25)',
          borderRadius: 12, padding: '14px 16px',
        }}>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Active Goal</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#c8fb57' }}>{goal}</div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Preset Goals</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PRESET_GOALS.map(g => (
            <button
              key={g.id}
              onClick={() => handleSelect(g.label)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: goal === g.label ? 'rgba(200,251,87,0.08)' : '#141414',
                border: `1px solid ${goal === g.label ? 'rgba(200,251,87,0.3)' : '#2a2a2a'}`,
                borderRadius: 10, padding: '12px 14px', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 18 }}>{g.icon}</span>
              <span style={{ fontSize: 14, color: goal === g.label ? '#c8fb57' : '#a0a0a0', fontWeight: goal === g.label ? 600 : 400 }}>
                {g.label}
              </span>
              {goal === g.label && <span style={{ marginLeft: 'auto', fontSize: 13, color: '#c8fb57' }}>✓</span>}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Custom Goal</div>
        {editing ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              value={custom}
              onChange={e => setCustom(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCustomSubmit()}
              placeholder="e.g. Run my first 50K"
              style={{
                flex: 1, background: '#141414', border: '1px solid #3a3a3a',
                borderRadius: 10, padding: '12px 14px', color: '#f0f0f0', fontSize: 14,
              }}
            />
            <button
              onClick={handleCustomSubmit}
              style={{
                background: '#c8fb57', color: '#0a0a0a', borderRadius: 10,
                padding: '0 16px', fontWeight: 600, fontSize: 14, border: 'none', cursor: 'pointer',
              }}
            >Set</button>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            style={{
              width: '100%', background: '#141414', border: '1px dashed #333',
              borderRadius: 10, padding: '12px 14px', color: '#555',
              fontSize: 14, cursor: 'pointer', textAlign: 'left',
            }}
          >
            + Enter a custom goal...
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: (active) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="7" height="7" rx="1.5" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8"/>
      <rect x="14" y="3" width="7" height="7" rx="1.5" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8"/>
      <rect x="3" y="14" width="7" height="7" rx="1.5" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8"/>
      <rect x="14" y="14" width="7" height="7" rx="1.5" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8"/>
    </svg>
  )},
  { id: 'coach', label: 'Coach', icon: (active) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )},
  { id: 'plans', label: 'Plans', icon: (active) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <polyline points="14,2 14,8 20,8" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <line x1="8" y1="13" x2="16" y2="13" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8" strokeLinecap="round"/>
      <line x1="8" y1="17" x2="13" y2="17" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )},
  { id: 'goals', label: 'Goals', icon: (active) => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8"/>
      <circle cx="12" cy="12" r="6" stroke={active ? '#c8fb57' : '#555'} strokeWidth="1.8"/>
      <circle cx="12" cy="12" r="2" fill={active ? '#c8fb57' : '#555'}/>
    </svg>
  )},
]

// ─── App root ─────────────────────────────────────────────────────────────────

export default function App() {
  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('tab') || 'dashboard'
  })
  const [goal, setGoal] = useState(ATHLETE_BASE.goal)
  const [activePlan, setActivePlan] = useState(null)
  const [coachMessage, setCoachMessage] = useState(null)
  const coachKey = useRef(0)

  // Strava state
  const [stravaConnected, setStravaConnected] = useState(false)
  const [stravaLoading, setStravaLoading] = useState(false)
  const [stravaError, setStravaError] = useState(null)
  const [stravaAthlete, setStravaAthlete] = useState(null)
  const [stravaActivities, setStravaActivities] = useState([])

  // Load Strava data from token
  const loadStravaData = useCallback(async () => {
    try {
      setStravaLoading(true)
      setStravaError(null)
      const token = await stravaGetValidToken()
      if (!token) { setStravaConnected(false); return }

      const [athlete, activities] = await Promise.all([
        stravaFetchAthlete(token),
        stravaFetchActivities(token, 30),
      ])
      setStravaAthlete(athlete)
      setStravaActivities(activities.filter(a => a.sport_type === 'Run' || a.type === 'Run'))
      setStravaConnected(true)
    } catch (e) {
      setStravaError(e.message)
      setStravaConnected(false)
    } finally {
      setStravaLoading(false)
    }
  }, [])

  // Handle Strava OAuth callback (code in URL)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const scope = params.get('scope')

    if (code && scope && scope.includes('activity')) {
      // Clean the URL
      window.history.replaceState({}, '', window.location.pathname)

      ;(async () => {
        try {
          setStravaLoading(true)
          setStravaError(null)
          const tokenData = await stravaExchangeToken(code)
          if (tokenData.errors) throw new Error(tokenData.message || 'Auth failed')
          localStorage.setItem('strava_token', JSON.stringify(tokenData))
          await loadStravaData()
        } catch (e) {
          setStravaError(`Strava auth failed: ${e.message}`)
          setStravaLoading(false)
        }
      })()
    } else if (localStorage.getItem('strava_token')) {
      loadStravaData()
    }
  }, [loadStravaData])

  const handleConnectStrava = () => {
    if (!STRAVA_CLIENT_ID) return
    window.location.href = stravaAuthUrl()
  }

  const handleDisconnectStrava = () => {
    localStorage.removeItem('strava_token')
    setStravaConnected(false)
    setStravaAthlete(null)
    setStravaActivities([])
  }

  // Build effective athlete data (real data overrides base)
  const runs = stravaActivities.slice(0, 5).map(mapStravaRun)
  const { totalMiles, trend } = stravaConnected && stravaActivities.length
    ? computeWeeklyMiles(stravaActivities)
    : { totalMiles: 0, trend: '—' }

  const athlete = {
    ...ATHLETE_BASE,
    name: stravaAthlete ? stravaAthlete.firstname : ATHLETE_BASE.name,
    recentRuns: stravaConnected ? runs : [],
    weeklyMileage: totalMiles,
    connectedApps: stravaConnected ? ['Strava'] : [],
  }

  const weekly = {
    ...WEEKLY_BASE,
    totalMiles,
    trend,
  }

  const goToCoach = (msg) => {
    coachKey.current++
    setCoachMessage(msg)
    setTab('coach')
  }

  return (
    <div style={{
      width: '100%', maxWidth: 430, minHeight: '100dvh',
      display: 'flex', flexDirection: 'column', background: '#0a0a0a', position: 'relative',
    }}>
      {stravaError && (
        <div style={{
          background: 'rgba(255,91,91,0.1)', borderBottom: '1px solid rgba(255,91,91,0.3)',
          padding: '10px 16px', fontSize: 12, color: '#ff5b5b', display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <span style={{ flex: 1 }}>⚠ {stravaError}</span>
          <button onClick={() => setStravaError(null)} style={{ background: 'none', border: 'none', color: '#ff5b5b', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: tab === 'coach' ? 'hidden' : 'auto', display: 'flex', flexDirection: 'column' }}>
        {tab === 'dashboard' && (
          <Dashboard
            athlete={athlete}
            weekly={weekly}
            onAskCoach={goToCoach}
            stravaConnected={stravaConnected}
            onConnectStrava={handleConnectStrava}
            onDisconnectStrava={handleDisconnectStrava}
            loading={stravaLoading}
          />
        )}
        {tab === 'coach' && (
          <Coach
            key={coachKey.current}
            initialMessage={coachMessage}
            athlete={athlete}
            weekly={weekly}
            goal={goal}
          />
        )}
        {tab === 'plans' && <Plans activePlan={activePlan} setActivePlan={setActivePlan} />}
        {tab === 'goals' && <Goals goal={goal} setGoal={setGoal} />}
      </div>

      <div style={{
        height: 64, borderTop: '1px solid #1a1a1a', display: 'flex',
        background: 'rgba(10,10,10,0.95)', backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)', flexShrink: 0,
      }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 4,
              background: 'transparent', border: 'none', cursor: 'pointer', padding: '8px 0',
            }}
          >
            {t.icon(tab === t.id)}
            <span style={{
              fontSize: 10, fontWeight: 500, letterSpacing: '0.03em',
              color: tab === t.id ? '#c8fb57' : '#444',
            }}>
              {t.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
