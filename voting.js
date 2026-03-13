const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MIN_VOTES_FOR_VERDICT = 5;
const AI_THRESHOLD = 0.65;
const REAL_THRESHOLD = 0.35;
const BAD_ACTOR_THRESHOLD = 0.2;
const RELIABILITY_DECAY = 0.05;

async function getOrCreateVoter(voter_id) {
  const { data } = await supabase.from('voter_reliability').select('*').eq('voter_id', voter_id).single();
  if (data) return data;
  const { data: nv, error } = await supabase.from('voter_reliability').insert({ voter_id, reliability: 0.5, total_votes: 0, correct_votes: 0 }).select().single();
  if (error) throw error;
  return nv;
}

async function recomputeVerdict(media_url, tweet_id) {
  const { data: votes, error } = await supabase.from('media_votes').select('vote, voter_id').eq('media_url', media_url);
  if (error) throw error;
  const voterIds = votes.map(v => v.voter_id);
  const { data: voters } = await supabase.from('voter_reliability').select('voter_id, reliability, flagged').in('voter_id', voterIds);
  const rm = {}; for (const v of (voters || [])) rm[v.voter_id] = v.flagged ? 0 : v.reliability;
  let wAi = 0, wReal = 0, aiC = 0, realC = 0;
  for (const v of votes) {
    const w = rm[v.voter_id] ?? 0.5;
    if (v.vote === 'ai') { wAi += w; aiC++; } else { wReal += w; realC++; }
  }
  const total = votes.length, tw = wAi + wReal;
  const aiScore = tw > 0 ? wAi / tw : 0;
  const minMet = total >= MIN_VOTES_FOR_VERDICT;
  let verdict = 'unknown';
  if (minMet) { if (aiScore >= AI_THRESHOLD) verdict = 'ai'; else if (aiScore <= REAL_THRESHOLD) verdict = 'real'; else verdict = 'disputed'; }
  const { data, error: ue } = await supabase.from('media_verdicts').upsert({
    media_url, tweet_id: tweet_id || null, total_votes: total, ai_votes: aiC, real_votes: realC,
    weighted_ai: wAi, weighted_real: wReal, ai_score: aiScore, verdict, min_votes_met: minMet, updated_at: new Date().toISOString()
  }, { onConflict: 'media_url' }).select().single();
  if (ue) throw ue;
  return data;
}

async function recalibrateVotersForMedia(media_url, groundTruth) {
  const { data: votes } = await supabase.from('media_votes').select('voter_id, vote').eq('media_url', media_url);
  if (!votes) return;
  for (const v of votes) {
    const correct = v.vote === groundTruth;
    const voter = await getOrCreateVoter(v.voter_id);
    let nr = voter.reliability, nc = voter.correct_votes;
    if (correct) { nc++; nr = Math.min(1.0, nr + RELIABILITY_DECAY * 0.5); }
    else { nr = Math.max(0.0, nr - RELIABILITY_DECAY); }
    await supabase.from('voter_reliability').update({ correct_votes: nc, reliability: nr, flagged: nr < BAD_ACTOR_THRESHOLD }).eq('voter_id', v.voter_id);
  }
}

// POST /vote-media
router.post('/vote-media', async (req, res) => {
  try {
    const { media_url, tweet_id, voter_id, vote } = req.body;
    if (!media_url || !voter_id || !['ai', 'real'].includes(vote)) return res.status(400).json({ error: 'Missing fields: media_url, voter_id, vote' });
    const voter = await getOrCreateVoter(voter_id);
    if (voter.flagged) return res.status(403).json({ error: 'Vote not counted', reason: 'voter_flagged' });
    const { data: vd, error: ve } = await supabase.from('media_votes').upsert({ media_url, tweet_id: tweet_id || null, voter_id, vote, created_at: new Date().toISOString() }, { onConflict: 'media_url,voter_id' }).select().single();
    if (ve) throw ve;
    const verdict = await recomputeVerdict(media_url, tweet_id);
    const { count } = await supabase.from('media_votes').select('*', { count: 'exact', head: true }).eq('voter_id', voter_id);
    await supabase.from('voter_reliability').update({ total_votes: count, last_vote_at: new Date().toISOString() }).eq('voter_id', voter_id);
    res.json({ success: true, vote: vd, verdict });
  } catch (err) { console.error('POST /vote-media error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /media-scores/batch
router.post('/media-scores/batch', async (req, res) => {
  try {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: 'urls must be a non-empty array' });
    const { data, error } = await supabase.from('media_verdicts').select('*').in('media_url', urls.slice(0, 50));
    if (error) throw error;
    const results = {};
    for (const r of (data || [])) results[r.media_url] = { ai_score: r.ai_score, verdict: r.verdict, total_votes: r.total_votes, ai_votes: r.ai_votes, real_votes: r.real_votes, min_votes_met: r.min_votes_met };
    res.json({ results });
  } catch (err) { console.error('POST /media-scores/batch error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /voter/:voter_id
router.get('/voter/:voter_id', async (req, res) => {
  try {
    const voter = await getOrCreateVoter(req.params.voter_id);
    res.json({ voter_id: voter.voter_id, reliability: voter.reliability, total_votes: voter.total_votes, correct_votes: voter.correct_votes, flagged: voter.flagged });
  } catch (err) { console.error('GET /voter error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /ai-verdict (admin override)
router.post('/ai-verdict', async (req, res) => {
  try {
    const { media_url, verdict, admin_key } = req.body;
    if (admin_key !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!media_url || !['ai', 'real'].includes(verdict)) return res.status(400).json({ error: 'Invalid media_url or verdict' });
    const { data, error } = await supabase.from('media_verdicts').upsert({ media_url, ai_score: verdict === 'ai' ? 1.0 : 0.0, verdict, min_votes_met: true, updated_at: new Date().toISOString() }, { onConflict: 'media_url' }).select().single();
    if (error) throw error;
    await recalibrateVotersForMedia(media_url, verdict);
    res.json({ success: true, verdict: data });
  } catch (err) { console.error('POST /ai-verdict error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /ai-verdict/check
router.get('/ai-verdict/check', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url query param required' });
    const { data, error } = await supabase.from('media_verdicts').select('*').eq('media_url', url).single();
    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return res.json({ found: false });
    res.json({ found: true, ai_score: data.ai_score, verdict: data.verdict, total_votes: data.total_votes, min_votes_met: data.min_votes_met });
  } catch (err) { console.error('GET /ai-verdict/check error:', err); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
