const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use(cors());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

async function getCountryFromIP(ip) {
  try {
    const r = await fetch('http://ip-api.com/json/' + ip + '?fields=countryCode');
    const d = await r.json();
    return d.countryCode || null;
  } catch { return null; }
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/scores/:handle', async (req, res) => {
  const handle = req.params.handle.toLowerCase().replace('@', '');
  const raterCountry = req.query.raterCountry || null;
  const cacheKey = 'score:' + handle + ':' + raterCountry;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);
  try {
    let q = supabase.from('ratings').select('trust, rater_country').eq('handle', handle);
    if (raterCountry) q = q.eq('rater_country', raterCountry);
    const { data, error } = await q;
    if (error) throw error;
    const total = data.length;
    const trusted = data.filter(r => r.trust === true).length;
    const score = total > 0 ? Math.round((trusted / total) * 100) : null;
    const breakdown = {};
    for (const r of data) {
      const c = r.rater_country || 'unknown';
      if (!breakdown[c]) breakdown[c] = { trusted: 0, total: 0 };
      breakdown[c].total++;
      if (r.trust) breakdown[c].trusted++;
    }
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: notes } = await supabase.from('community_notes').select('created_at').eq('handle', handle).gte('created_at', ninetyDaysAgo);
    const result = { handle, score, total, trusted, breakdown, communityNotes90d: notes ? notes.length : 0, cachedAt: Date.now() };
    setCache(cacheKey, result);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/batch', async (req, res) => {
  const { handles, raterCountry } = req.body;
  if (!handles || !Array.isArray(handles) || handles.length > 50)
    return res.status(400).json({ error: 'handles must be array of up to 50' });
  const results = {};
  const toFetch = [];
  for (const h of handles) {
    const handle = h.toLowerCase().replace('@', '');
    const cached = getCached('score:' + handle + ':' + (raterCountry || ''));
    if (cached) results[handle] = cached;
    else toFetch.push(handle);
  }
  if (toFetch.length > 0) {
    let q = supabase.from('ratings').select('handle, trust, rater_country').in('handle', toFetch);
    if (raterCountry) q = q.eq('rater_country', raterCountry);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    const grouped = {};
    for (const r of data) {
      if (!grouped[r.handle]) grouped[r.handle] = [];
      grouped[r.handle].push(r);
    }
    for (const handle of toFetch) {
      const rows = grouped[handle] || [];
      const total = rows.length;
      const trusted = rows.filter(r => r.trust).length;
      const score = total > 0 ? Math.round((trusted / total) * 100) : null;
      const result = { handle, score, total, trusted, cachedAt: Date.now() };
      setCache('score:' + handle + ':' + (raterCountry || ''), result);
      results[handle] = result;
    }
  }
  res.json(results);
});

app.post('/rate', async (req, res) => {
  const { handle, trust } = req.body;
  if (!handle || typeof trust !== 'boolean')
    return res.status(400).json({ error: 'handle and trust (boolean) required' });
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress;
  const raterCountry = await getCountryFromIP(ip);
  const { error } = await supabase.from('ratings').upsert({
    handle: handle.toLowerCase().replace('@', ''),
    rater_ip: ip,
    rater_country: raterCountry,
    trust,
    updated_at: new Date().toISOString()
  }, { onConflict: 'handle,rater_ip' });
  if (error) return res.status(500).json({ error: error.message });
  cache.delete('score:' + handle + ':' + raterCountry);
  cache.delete('score:' + handle + ':null');
  res.json({ ok: true, raterCountry });
});

app.listen(PORT, () => console.log('TrustLayer backend on port ' + PORT));
