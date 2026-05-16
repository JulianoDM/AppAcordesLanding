// ═══════ META CONVERSIONS API — eventos de funil ═══════
// Recebe os eventos de funil do navegador e reenvia pro Meta server-side.
// O navegador dispara o MESMO evento via pixel com o MESMO event_id →
// o Meta deduplica (não conta dobrado).
//
// Purchase NÃO passa por aqui — é responsabilidade do Wiapy (integração
// Meta no painel do Wiapy). Este endpoint só aceita eventos de funil.
//
// Token fica só aqui (env server-side), nunca exposto no HTML/browser.

const META_API_VERSION = 'v21.0';
const ALLOWED_EVENTS = ['PageView', 'ViewContent', 'InitiateCheckout'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const PIXEL_ID = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_CAPI_TOKEN;
  if (!PIXEL_ID || !TOKEN) {
    // Ainda não configurado (pré-lançamento). Browser ignora silenciosamente.
    res.status(500).json({ error: 'capi_not_configured' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  const { event_name, event_id, event_source_url, custom_data, fbp, fbc } = body;

  if (!event_name || ALLOWED_EVENTS.indexOf(event_name) === -1 || !event_id) {
    res.status(400).json({ error: 'invalid_event' });
    return;
  }

  // IP real (Vercel injeta x-forwarded-for); 1º da lista é o cliente.
  const xff = req.headers['x-forwarded-for'] || '';
  const ip = xff.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
  const ua = req.headers['user-agent'] || '';

  const user_data = {
    client_ip_address: ip,
    client_user_agent: ua,
  };
  if (fbp) user_data.fbp = fbp;
  if (fbc) user_data.fbc = fbc;

  const payload = {
    data: [{
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,
      event_source_url: event_source_url || '',
      action_source: 'website',
      user_data,
      ...(custom_data && typeof custom_data === 'object' ? { custom_data } : {}),
    }],
  };

  try {
    const r = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(TOKEN)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(502).json({ error: 'meta_rejected', detail: j });
      return;
    }
    res.status(200).json({ ok: true, events_received: j.events_received });
  } catch (e) {
    res.status(500).json({ error: 'capi_request_failed' });
  }
}
