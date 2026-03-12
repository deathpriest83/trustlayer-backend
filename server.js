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
      results[h] = { trusted: s.trusted, distrusted: s.distrusted, total: s.total, country: pc, countrySource: cMap[h]?.source || null, countryConfidence: cMap[h]?.confidence || null, freedomStatus: getFreedomStatus(pc), aiProb: null, botScore: bot?.score ?? null, botSignals: bot?.signals ?? null, communityNotes: cn?.count ?? null, communityNotesDetails: cn?.details?.slice(0, 5) ?? null, accountAiRatio: null };
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

// --- AI verdict endpoints ---
app.post('/ai-verdict', async (req, res) => {
  try {
    const {tweet_id, handle, ai_score, grok_text, verdict} = req.body;
    if (!tweet_id || !handle) return res.status(400).json({error:'tweet_id and handle required'});
    const n = handle.toLowerCase().replace(/^@/,'');
    await supabase.from('ai_verdicts').upsert({tweet_id, handle:n, ai_score:ai_score||0, grok_text:grok_text||null, verdict:verdict||null},{onConflict:'tweet_id'});
    const {data:counts} = await supabase.from('ai_verdicts').select('ai_score').eq('handle',n);
    if (counts && counts.length > 0) {
      const total=counts.length, flagged=counts.filter(c=>c.ai_score>0.5).length;
      await supabase.from('account_ai_scores').upsert({handle:n,total_analyzed:total,total_flagged:flagged,ai_ratio:flagged/total,last_updated:new Date().toISOString()},{onConflict:'handle'});
    }
    res.json({success:true});
  } catch(e) { console.error('/ai-verdict',e); res.status(500).json({error:'internal error'}); }
});

app.post('/ai-verdict/check', async (req, res) => {
  try {
    const {tweet_ids} = req.body;
    if (!tweet_ids || !Array.isArray(tweet_ids)) return res.json({verdicts:{}});
    const {data} = await supabase.from('ai_verdicts').select('tweet_id,ai_score,verdict').in('tweet_id',tweet_ids.slice(0,50));
    const map = {};
    for (const v of (data||[])) map[v.tweet_id] = {ai_score:v.ai_score,verdict:v.verdict};
    res.json({verdicts:map});
  } catch(e) { res.status(500).json({error:'internal error'}); }
});

app.get('/ai-verdicts/:handle', async (req, res) => {
  try {
    const n = req.params.handle.toLowerCase().replace(/^@/,'');
    const {data:verdicts} = await supabase.from('ai_verdicts').select('tweet_id,ai_score,verdict,created_at').eq('handle',n).order('created_at',{ascending:false}).limit(20);
    const {data:account} = await supabase.from('account_ai_scores').select('*').eq('handle',n).limit(1);
    res.json({verdicts:verdicts||[], account:account?.[0]||null});
  } catch(e) { res.status(500).json({error:'internal error'}); }
});

// --- POST /seed --- trigger account location seeder ---
const BEARER_TK = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const Q_ID = 'zs_jFPFT78rBpXv9Z3U2YQ';
const C2C = {'united states':'US','united kingdom':'GB','canada':'CA','australia':'AU','germany':'DE','france':'FR','netherlands':'NL','japan':'JP','south korea':'KR','italy':'IT','spain':'ES','argentina':'AR','south africa':'ZA','india':'IN','brazil':'BR','mexico':'MX','russia':'RU','china':'CN','iran':'IR','saudi arabia':'SA','united arab emirates':'AE','turkey':'TR','thailand':'TH','vietnam':'VN','egypt':'EG','pakistan':'PK','israel':'IL','greece':'GR','romania':'RO','singapore':'SG','malaysia':'MY','hong kong':'HK'};
const R2C = {'eastern europe (non-eu)':'R_EE_NONEU','southeast asia':'R_SEA','south asia':'R_SA','east asia':'R_EA','middle east':'R_ME','sub-saharan africa':'R_SSA','north america':'R_NAM','south america':'R_SAM','oceania':'R_OCE'};
function resLoc(raw){if(!raw)return null;var l=raw.toLowerCase().trim();if(R2C[l])return{code:R2C[l],isRegion:true};if(C2C[l])return{code:C2C[l],isRegion:false};return null;}
app.post('/seed', async (req, res) => {
  const ct0=process.env.SCRAPER_CT0, authTk=process.env.SCRAPER_AUTH_TOKEN;
  if(!ct0||!authTk) return res.json({error:'no scraper cookies'});
  const limit=req.body.limit||50;
  const {data:queue}=await supabase.from('seeder_queue').select('handle').eq('scraped',false).order('priority',{ascending:false}).limit(limit);
  if(!queue||queue.length===0) return res.json({message:'queue empty'});
  res.json({message:'seeding started',handles:queue.length});
  let scraped=0,saved=0;
  for(const item of queue){
    try{
      const url='https://x.com/i/api/graphql/'+Q_ID+'/AboutAccountQuery?variables='+encodeURIComponent(JSON.stringify({screenName:item.handle}));
      const r=await fetch(url,{headers:{'authorization':BEARER_TK,'x-csrf-token':ct0,'cookie':'ct0='+ct0+'; auth_token='+authTk,'x-twitter-auth-type':'OAuth2Session','x-twitter-active-user':'yes','content-type':'application/json','user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}});
      if(r.status===429){console.log('[Seed] Rate limited');await new Promise(w=>setTimeout(w,60000));continue;}
      if(!r.ok){await supabase.from('seeder_queue').update({scraped:true}).eq('handle',item.handle);continue;}
      const json=await r.json();let about;try{about=json.data.user_result_by_screen_name.result.about_profile;}catch(e){}
      scraped++;
      if(about){
        let cc=null,src=null,conf=0,rawLoc=null;
        if(about.source){const m=about.source.match(/^(.+?)\s*App Store/i);if(m){const rl=resLoc(m[1].replace(/^U\.S\.$/,'United States'));if(rl&&!rl.isRegion){cc=rl.code;src='app_store';conf=1.0;rawLoc=about.source;}}}
        if(!cc&&about.account_based_in){const rl=resLoc(about.account_based_in);if(rl){cc=rl.code;src=rl.isRegion?'account_based_in_region':'account_based_in';conf=rl.isRegion?0.7:0.95;rawLoc=about.account_based_in;}}
        if(cc){await supabase.from('poster_countries').upsert({handle:item.handle.toLowerCase(),country_code:cc,source:src,confidence:conf,submission_count:1,raw_location:rawLoc,vpn_warning:about.location_accurate===false},{onConflict:'handle'});saved++;console.log('[Seed] '+scraped+' @'+item.handle+': '+cc);}
        else console.log('[Seed] '+scraped+' @'+item.handle+': no location');
      }
      await supabase.from('seeder_queue').update({scraped:true}).eq('handle',item.handle);
      await new Promise(w=>setTimeout(w,5000));
    }catch(e){console.log('[Seed] Error:',e.message);await new Promise(w=>setTimeout(w,10000));}
  }
  console.log('[Seed] Done. Scraped:'+scraped+' Saved:'+saved);
});

// --- POST /seed/add --- extension adds handles to scrape queue ---
app.post('/seed/add', async (req, res) => {
  const { handles } = req.body;
  if (!handles || !Array.isArray(handles) || handles.length === 0) return res.json({added: 0});
  const rows = handles.slice(0, 50).map(h => ({handle: h.toLowerCase().replace(/^@/,''), priority: 10, scraped: false}));
  const { error } = await supabase.from('seeder_queue').upsert(rows, {onConflict: 'handle', ignoreDuplicates: true});
  if (error) console.log('[Seed/add] Error:', error.message);
  res.json({added: rows.length});
});

// --- Auto-seeder: process queue every 5 minutes ---
let seederRunning = false;
async function autoSeed() {
  if (seederRunning) return;
  const ct0 = process.env.SCRAPER_CT0, authTk = process.env.SCRAPER_AUTH_TOKEN;
  if (!ct0 || !authTk) return;
  const {data: queue} = await supabase.from('seeder_queue').select('handle').eq('scraped', false).order('priority', {ascending: false}).limit(10);
  if (!queue || queue.length === 0) return;
  seederRunning = true;
  console.log('[AutoSeed] Processing ' + queue.length + ' handles...');
  for (const item of queue) {
    try {
      const url = 'https://x.com/i/api/graphql/' + Q_ID + '/AboutAccountQuery?variables=' + encodeURIComponent(JSON.stringify({screenName: item.handle}));
      const r = await fetch(url, {headers: {'authorization': BEARER_TK, 'x-csrf-token': ct0, 'cookie': 'ct0=' + ct0 + '; auth_token=' + authTk, 'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}});
      if (r.status === 429) { console.log('[AutoSeed] Rate limited, stopping'); break; }
      if (!r.ok) { await supabase.from('seeder_queue').update({scraped: true}).eq('handle', item.handle); continue; }
      const json = await r.json(); let about; try { about = json.data.user_result_by_screen_name.result.about_profile; } catch(e) {}
      if (about) {
        let cc = null, src = null, conf = 0, rawLoc = null;
        if (about.source) { const m = about.source.match(/^(.+?)\s*App Store/i); if (m) { const rl = resLoc(m[1].replace(/^U\.S\.$/,'United States')); if (rl && !rl.isRegion) { cc=rl.code; src='app_store'; conf=1.0; rawLoc=about.source; }}}
        if (!cc && about.account_based_in) { const rl = resLoc(about.account_based_in); if (rl) { cc=rl.code; src=rl.isRegion?'account_based_in_region':'account_based_in'; conf=rl.isRegion?0.7:0.95; rawLoc=about.account_based_in; }}
        if (cc) { await supabase.from('poster_countries').upsert({handle: item.handle.toLowerCase(), country_code: cc, source: src, confidence: conf, submission_count: 1, raw_location: rawLoc, vpn_warning: about.location_accurate===false}, {onConflict: 'handle'}); console.log('[AutoSeed] @' + item.handle + ': ' + cc); }
      }
      await supabase.from('seeder_queue').update({scraped: true}).eq('handle', item.handle);
      await new Promise(w => setTimeout(w, 5000));
    } catch(e) { console.log('[AutoSeed] Error:', e.message); }
  }
  seederRunning = false;
}
setInterval(autoSeed, 5 * 60 * 1000);
setTimeout(autoSeed, 30000);

// --- POST /ai-verdict --- store Grok AI analysis verdict ---
app.post('/ai-verdict', async (req, res) => {
  try {
    const { tweet_id, handle, ai_probability, grok_text, verdict, reported_by } = req.body;
    if (!tweet_id || !handle || !verdict) return res.status(400).json({error: 'tweet_id, handle, verdict required'});
    const n = handle.toLowerCase().replace(/^@/, '');
    
    // Store individual verdict
    await supabase.from('ai_verdicts').upsert({
      tweet_id, handle: n, verdict, confidence: ai_probability || null,
      grok_text: (grok_text || '').substring(0, 500), source: 'grok_reply'
    }, {onConflict: 'tweet_id'});
    
    // Update account AI score
    const {data: verdicts} = await supabase.from('ai_verdicts').select('verdict').eq('handle', n);
    if (verdicts && verdicts.length > 0) {
      const total = verdicts.length;
      const flagged = verdicts.filter(v => v.verdict === 'ai_likely').length;
      const ratio = total > 0 ? flagged / total : 0;
      await supabase.from('account_ai_scores').upsert({
        handle: n, total_analyzed: total, total_ai_flagged: flagged,
        ai_ratio: Math.round(ratio * 100) / 100,
        last_verdict_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, {onConflict: 'handle'});
    }
    
    res.json({success: true, tweet_id, handle: n, verdict});
  } catch(err) { console.error('/ai-verdict', err); res.status(500).json({error: 'internal error'});
app.post('/ai-verdict/check', async (req, res) => {
  try {
    const {tweet_ids} = req.body;
    if (!tweet_ids) return res.json({verdicts:{}});
    const {data} = await supabase.from('ai_verdicts').select('tweet_id,ai_score,verdict').in('tweet_id',tweet_ids.slice(0,50));
    const map = {}; for (const v of (data||[])) map[v.tweet_id] = {ai_score:v.ai_score,verdict:v.verdict};
    res.json({verdicts:map});
  } catch(e) { res.status(500).json({error:'internal error'}); }
});
app.get('/ai-account/:handle', async (req, res) => {
  try {
    const n = req.params.handle.toLowerCase().replace(/^@/,'');
    const {data} = await supabase.from('account_ai_scores').select('*').eq('handle',n).limit(1);
    if (data && data.length > 0) res.json(data[0]);
    else res.json({handle:n, total_analyzed:0, total_flagged:0, ai_ratio:0});
  } catch(e) { res.status(500).json({error:'internal error'}); }
});
 }
});

// --- GET /ai-score/:handle --- get account AI posting ratio ---
app.get('/ai-score/:handle', async (req, res) => {
  try {
    const n = req.params.handle.toLowerCase().replace(/^@/, '');
    const {data} = await supabase.from('account_ai_scores').select('*').eq('handle', n).limit(1);
    if (data && data.length > 0) res.json(data[0]);
    else res.json({handle: n, total_analyzed: 0, total_ai_flagged: 0, ai_ratio: 0});
  } catch(err) { res.status(500).json({error: 'internal error'}); }
});

app.listen(P, () => console.log(`TrustLayer backend v3 running on port ${P}`));
