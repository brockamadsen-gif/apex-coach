// Initiates a Composio OAuth link session.
// Requires an Auth Config to be created in Composio dashboard for each app first.
// See: https://docs.composio.dev/docs/auth-configuration/custom-auth-configs

const AUTH_CONFIG_IDS = {
  garmin: process.env.COMPOSIO_AUTH_CONFIG_GARMIN,
  oura: process.env.COMPOSIO_AUTH_CONFIG_OURA,
  whoop: process.env.COMPOSIO_AUTH_CONFIG_WHOOP,
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { app } = req.body
  if (!app) return res.status(400).json({ error: 'app is required' })

  const authConfigId = AUTH_CONFIG_IDS[app]
  if (!authConfigId) {
    return res.status(400).json({
      error: `No COMPOSIO_AUTH_CONFIG_${app.toUpperCase()} env var set. Create an Auth Config for ${app} in app.composio.dev → Auth Configs, then add the ID to your env.`,
    })
  }

  const baseUrl = req.headers.origin || `https://${req.headers.host}`

  const response = await fetch('https://backend.composio.dev/api/v3/connected_accounts/link', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.COMPOSIO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: 'default',
      callback_url: `${baseUrl}?composio_app=${app}`,
    }),
  })

  const data = await response.json()
  if (!response.ok) {
    return res.status(response.status).json({ error: data.message || data.error || JSON.stringify(data) })
  }

  res.json({ redirectUrl: data.redirect_url })
}
