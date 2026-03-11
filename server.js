const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// âââ Config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cxvnwquxtyvepktogomf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

app.use(cors());
app.use(express.json());
// âââ Freedom House classification ââââââââââââââââââââââââââââââââââ
const FREEDOM_HOUSE = {
  free: new Set(['US','GB','CA','AU','DE','FR','NL','JP','KR','IT','ES','AR','ZA','SE','NO','DK','FI','IE','NZ','PT','BE','AT','CH','CZ','PL','TW','UY','CR','CL','IS','LU','MT','EE','LV','LT','SK','SI','HR','CY','RO','BG','GR','IL']),
  partly_free: new Set(['IN','BR','MX','NG','PH','ID','UA','GE','KE','SN','CO','PE','EC','HU','RS','BA','ME','AL','MK','MD','KG','PK','BD','LK','TN','GH']),
  not_free: new Set(['RU','CN','IR','SA','AE','KP','CU','VE','BY','TR','TH','MM','VN','EG','SY','AF','IQ','SD','ET','ER','TM','UZ','TJ','KZ','AZ','BH','QA','OM','KW','JO','LB','LY','DZ','MA','CM','CD','CG','TD','CF','RW','BI','UG','TZ','ZW','MZ','AO'])
};
function getFreedomStatus(cc) {
  if (!cc) return 'unknown';
  const c = cc.toUpperCase();
  const RF = {'R_EE_NONEU':'not_free','R_EE':'partly_free','R_EE_EU':'free','R_WE':'free','R_NE':'free','R_SE_EUR':'free','R_CE':'free','R_SEA':'partly_free','R_SA':'partly_free','R_EA':'partly_free','R_CA':'not_free','R_ME':'not_free','R_MENA':'not_free','R_NA':'not_free','R_SSA':'partly_free','R_WA':'partly_free','R_EAF':'partly_free','R_SAF':'partly_free','R_CAF':'not_free','R_NAM':'free','R_CAM':'partly_free','R_SAM':'partly_free','R_CAR':'partly_free','R_OCE':'free','R_AFR':'partly_free','R_ASIA':'partly_free','R_EUR':'free','R_AMER':'partly_free'};
  if (c.startsWith('R_')) return RF[c] || 'unknown';
  if (FREEDOM_HOUSE.free.has(c)) return 'free';
  if (FREEDOM_HOUSE.partly_free.has(c)) return 'partly_free';
  if (FREEDOM_HOUSE.not_free.has(c)) return 'not_free';
  return 'unknown';
}
function filterScores(ratings, posterCountry, settings) {
  if (settings.posterCountries?.length > 0 && posterCountry && !settings.posterCountries.includes(posterCountry.toUpperCase())) {
    return { trusted: 0, distrusted: 0, total: 0 };
  }
  const t = ratings.filter(r => r.trusted === true).length;
  const d = ratings.filter(r => r.trusted === false).length;
  return { trusted: t, distrusted: d, total: t + d };
}
app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.0.0' }));
app.post('/batch', async (req, res) => {
  try {
    const { handles, settings = {} } = req.body;
    if (!handles || !handles.length) return res.status(400).json({ error: 'handles required' });
    if (handles.length > 50) return res.status(400).json({ error: 'max 50' });
    const norm = handles.map(h => h.toLowerCase().replace(/^@/, ''));
    const { data: ratings } = await supabase.from('ratings').select('handle,user_id,trusted').in('handle', norm);
    const { data: countries } = await supabase.from('poster_countries').select('handle,country_code,source,confidence').in('handle', norm);
    const cMap = {};
    for (const c of (countries || [])) { if (!cMap[c.handle] || c.confidence > cMap[c.handle].confidence) cMap[c.handle] = c; }
    const d90 = new Date(Date.now() - 90 * 86400000).toISOString();
    let cnData = []; try { const r = await supabase.from('community_notes').select('handle,note_id,summary,created_at').in('handle', norm).gte('created_at', d90); cnData = r.data || []; } catch(e) {}
    const cnMap = {};
    for (const cn of cnData) { if (!cnMap[cn.handle]) cnMap[cn.handle] = { count: 0, details: [] }; cnMap[cn.handle].count++; cnMap[cn.handle].details.push({ date: cn.created_at?.slice(0, 10), summary: cn.summary }); }
    let botData = []; try { const r = await supabase.from('bot_scores').select('handle,score,signals').in('handle', norm); botData = r.data || []; } catch(e) {}
    const bMap = {}; for (const b of botData) bMap[b.handle] = b;
    const results = {};
    for (const h of norm) {
      const hR = (ratings || []).filter(r => r.handle === h);
      const pc = cMap[h]?.country_code || null;
      const s = filterScores(hR, pc, settings);
      const cn = cnMap[h]; const bot = bMap[h];
      results[h] = { trusted: s.trusted, distrusted: s.distrusted, total: s.total, country: pc, countrySource: cMap[h]?.source || null, countryConfidence: cMap[h]?.confidence || null, freedomStatus: getFreedomStatus(pc), aiProb: null, botScore: bot?.score ?? null, botSignals: bot?.signals ?? null, communityNotes: cn?.count ?? null, communityNotesDetails: cn?.details?.slice(0, 5) ?? null };
    }
    res.json({ results });
  } catch (err) { console.error('/batch', err); res.status(500).json({ error: 'internal error' }); }
});
app.post('/rate', async (req, res) => {
  try {
    const { handle, user_id, trusted } = req.body;
    if (!handle || !user_id || typeof trusted !== 'boolean') return res.status(400).json({ error: 'handle, user_id, trusted required' });
    const n = handle.toLowerCase().replace(/^@/, '');
    const { data, error } = await supabase.from('ratings').upsert({ handle: n, user_id, trusted, updated_at: new Date().toISOString() }, { onConflict: 'handle,user_id' }).select();
    if (error) throw error;
    res.json({ success: true, rating: data?.[0] });
  } catch (err) { console.error('/rate', err); res.status(500).json({ error: 'internal error' }); }
});
app.post('/profile-country', async (req, res) => {
  try {
    const { handle, country_code, source, confidence, user_id, raw_location, vpn_warning } = req.body;
    if (!handle || !country_code) return res.status(400).json({ error: 'handle and country_code required' });
    const n = handle.toLowerCase().replace(/^@/, '');
    const cc = country_code.toUpperCase();
    const src = source || 'user_tag';
    const conf = confidence ?? (src === 'user_tag' ? 0.5 : 0.95);
    if (src === 'user_tag') {
      const { data: existing } = await supabase.from('poster_countries').select('source,country_code').eq('handle', n).in('source', ['app_store', 'account_based_in', 'account_based_in_region']).limit(1);
      if (existing?.length > 0 && existing[0].country_code !== cc) return res.status(409).json({ error: 'conflict', existing: existing[0] });
    }
    const { data: cur } = await supabase.from('poster_countries').select('confidence').eq('handle', n).limit(1);
    if (cur?.length > 0 && cur[0].confidence > conf) return res.json({ success: true, message: 'higher conf kept' });
    const up = { handle: n, country_code: cc, source: src, confidence: conf, submission_count: 1 };
    if (raw_location) up.raw_location = raw_location;
    if (vpn_warning) up.vpn_warning = true;
    await supabase.from('poster_countries').upsert(up, { onConflict: 'handle' });
    if (user_id) await supabase.from('country_submissions').insert({ handle: n, country_code: cc, user_id });
    res.json({ success: true, handle: n, country_code: cc, source: src });
  } catch (err) { console.error('/profile-country', err); res.status(500).json({ error: 'internal error' }); }
});
app.post('/bot-score', async (req, res) => {
  try {
    const { handle, signals } = req.body;
    if (!handle || !signals) return res.status(400).json({ error: 'handle and signals required' });
    const n = handle.toLowerCase().replace(/^@/, '');
    let score = 0; const w = {};
    if (signals.accountAgeDays < 30) { score += 0.3; w.newAccount = 'high'; } else if (signals.accountAgeDays < 180) { score += 0.15; w.newAccount = 'med'; }
    if (signals.followers && signals.following > 0) { const r = signals.followers / signals.following; if (r < 0.1) { score += 0.2; w.lowRatio = 'high'; } else if (r < 0.3) { score += 0.1; w.lowRatio = 'med'; } }
    if (signals.defaultProfileImage) { score += 0.15; w.defaultAvatar = 'yes'; }
    if (signals.noBio) { score += 0.1; w.noBio = 'yes'; }
    if (signals.tweetsPerDay > 50) { score += 0.25; w.highFreq = 'high'; } else if (signals.tweetsPerDay > 20) { score += 0.1; w.highFreq = 'med'; }
    score = Math.min(1, Math.max(0, score));
    await supabase.from('bot_scores').upsert({ handle: n, score, signals: w, updated_at: new Date().toISOString() }, { onConflict: 'handle' });
    res.json({ handle: n, botScore: score, signals: w });
  } catch (err) { console.error('/bot-score', err); res.status(500).json({ error: 'internal error' }); }
});
app.post('/detect-ai', async (req, res) => {
  try {
    const { media_url } = req.body;
    if (!media_url) return res.status(400).json({ error: 'media_url required' });
    const U = process.env.SIGHTENGINE_USER, S = process.env.SIGHTENGINE_SECRET;
    if (!U || !S) return res.json({ aiProb: null, error: 'not configured' });
    const r = await fetch(`https://api.sightengine.com/1.0/check.json?url=${encodeURIComponent(media_url)}&models=genai&api_user=${U}&api_secret=${S}`);
    const d = await r.json();
    res.json({ aiProb: d?.type?.ai_generated ?? null });
  } catch (err) { res.status(500).json({ error: 'internal error' }); }
});
const P = process.env.PORT || 3000;
app.listen(P, () => console.log(`TrustLayer backend v3 running on port ${P}`));
