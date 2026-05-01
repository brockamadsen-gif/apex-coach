export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const { app } = req.body
  if (!app) return res.status(400).json({ error: 'app is required' })

  const baseUrl = req.headers.origin || 'http://localhost:3000'

  const response = await fetch('https://backend.composio.dev/api/v1/connectedAccounts', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.COMPOSIO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      appName: app,
      entityId: 'default',
      redirectUri: baseUrl,
    }),
  })

  const data = await response.json()
  if (!response.ok) return res.status(response.status).json({ error: data.message || 'Composio error' })
  res.json({ redirectUrl: data.redirectUrl })
}
