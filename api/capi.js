// ═══════ META CONVERSIONS API — eventos de funil ═══════
// Recebe os eventos de funil do navegador e reenvia pro Meta server-side.
// O navegador dispara o MESMO evento via pixel com o MESMO event_id →
// o Meta deduplica (não conta dobrado).
//
// Suporta 2 pixels (multi-BM): pixel 1 (ABO) sempre; pixel 2 (CBO) só
// quando META_PIXEL_ID_2 + META_CAPI_TOKEN_2 estiverem configurados.
// O mesmo payload (mesmo event_id) vai pros dois → cada pixel deduplica
// com seu próprio evento de browser.
//
// Purchase NÃO passa por aqui — é responsabilidade do Wiapy (integração
// Meta no painel do Wiapy, configurada pros dois pixels). Este endpoint
// só aceita eventos de funil.
//
// Tokens ficam só aqui (env server-side), nunca expostos no HTML/browser.

const META_API_VERSION = 'v21.0';
const ALLOWED_EVENTS = ['PageView', 'ViewContent', 'InitiateCheckout'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // Monta a lista de pixels-alvo a partir dos env vars.
  // Pixel 1 é obrigatório (mantém comportamento atual). Pixel 2 é opcional.
  const targets = [];
  if (process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN) {
    targets.push({ id: process.env.META_PIXEL_ID, token: process.env.META_CAPI_TOKEN });
  }
  if (process.env.META_PIXEL_ID_2 && process.env.META_CAPI_TOKEN_2) {
    targets.push({ id: process.env.META_PIXEL_ID_2, token: process.env.META_CAPI_TOKEN_2 });
  }

  if (targets.length === 0) {
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

  const { event_name, event_id, event_source_url, custom_data, fbp, fbc, test_event_code } = body;

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
  // Só presente quando explicitamente testando (Test Events). Tráfego
  // real do navegador nunca manda isso → vai pra produção normal.
  if (test_event_code) payload.test_event_code = test_event_code;

  // Envia pros pixels em paralelo. Um falhar não derruba o outro.
  const sendTo = (target) => fetch(
    `https://graph.facebook.com/${META_API_VERSION}/${target.id}/events?access_token=${encodeURIComponent(target.token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  ).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    return { id: target.id, ok: r.ok, received: j.events_received, detail: r.ok ? undefined : j };
  });

  try {
    const settled = await Promise.allSettled(targets.map(sendTo));
    const results = settled.map((s, i) =>
      s.status === 'fulfilled' ? s.value : { id: targets[i].id, ok: false, detail: String(s.reason) }
    );

    const anyOk = results.some(r => r.ok);
    // Mantém compat: 200 se ao menos um pixel aceitou; 502 só se todos falharem.
    if (!anyOk) {
      res.status(502).json({ error: 'meta_rejected', results });
      return;
    }
    res.status(200).json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: 'capi_request_failed' });
  }
}
