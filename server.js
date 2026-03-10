// TrustLayer Backend API v2
// New: /profile-country endpoint, poster country in /batch, country tag abuse prevention

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://twitter.com', 'https://x.com', 'chrome-extension://*'],
  methods: ['GET', 'POST'],
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h

// Rate limiters
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Too many requests' } });
const rateLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, message: { error: 'Rating limit reached' } });
const profileLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many profile reports' } });
app.use(limiter);

// ── IP Geolocation ────────────────────────────────────────────────────────────
async function getCountryFromIP(ip) {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=countryCode,country`);
    const data = await res.json();
    return { code: data.countryCode || 'XX', name: data.country || 'Unknown' };
  } catch {
    return { code: 'XX', name: 'Unknown' };
  }
}

// ── POST /profile-country ─────────────────────────────────────────────────────
// Called by extension when visiting x.com/<handle>/about
// Scrapes Twitter's own verified fields (NOT user-editable bio location):
//   app_store        = "Connected via X App Store" (payment-linked, highest confidence)
//   account_based_in = "Account based in" field (Twitter-verified, high confidence)
//   user_tag         = crowdsourced submission (needs 3+ consensus)
app.post('/profile-country', profileLimiter, async (req, res) => {
  const { handle, countryCode, source, userId } = req.body;
  if (!handle || !countryCode || !source) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const h = handle.toLowerCase().replace('@', '');

  try {
    if (source === 'app_store' || source === 'account_based_in') {
      // Ground truth from Twitter's own verified fields — not user-editable
      // app_store = Connected via X App Store (payment-linked, highest confidence)
      // account_based_in = Twitter's "Account based in" field (verified, high confidence)
      const confidence = source === 'app_store' ? 1.0 : 0.95;
      const { error } = await supabase
        .from('poster_countries')
        .upsert({
          handle: h,
          country_code: countryCode,
          source,
          confidence,
          submission_count: 1,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'handle' });

      if (error) throw error;

      for (const key of cache.keys()) {
        if (key.startsWith(h + ':')) cache.delete(key);
      }

      return res.json({ success: true, source, countryCode });

    } else if (source === 'user_tag') {
      // Crowdsourced — record the submission and check consensus
      const { data: existing } = await supabase
        .from('poster_countries')
        .select('country_code, source, confidence')
        .eq('handle', h)
        .single();

      if (existing && ['app_store','account_based_in'].includes(existing.source) && existing.country_code !== countryCode) {
        return res.json({
          success: false,
          reason: 'conflicts_with_scraped',
          scrapedCountry: existing.country_code,
          message: 'Profile shows a different country than your tag',
        });
      }

      await supabase.from('country_submissions').insert({
        handle: h,
        country_code: countryCode,
        user_id: userId,
        created_at: new Date().toISOString(),
      });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: submissions } = await supabase
        .from('country_submissions')
        .select('country_code')
        .eq('handle', h)
        .gte('created_at', thirtyDaysAgo);

      const counts = {};
      (submissions || []).forEach(s => {
        counts[s.country_code] = (counts[s.country_code] || 0) + 1;
      });

      const leading = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

      if (leading && leading[1] >= 3) {
        const consensusCountry = leading[0];
        const confidence = Math.min(leading[1] / 10, 0.9);

        await supabase
          .from('poster_countries')
          .upsert({
            handle: h,
            country_code: consensusCountry,
            source: 'consensus',
            confidence,
            submission_count: leading[1],
            updated_at: new Date().toISOString(),
          }, { onConflict: 'handle' });

        for (const key of cache.keys()) {
          if (key.startsWith(h + ':')) cache.delete(key);
        }

        return res.json({ success: true, source: 'consensus', countryCode: consensusCountry, count: leading[1] });
      }

      return res.json({
        success: true,
        source: 'pending',
        submissionsNeeded: Math.max(0, 3 - (counts[countryCode] || 0)),
        message: 'Tag recorded — needs more submissions to reach consensus',
      });
    }

    return res.status(400).json({ error: 'Invalid source' });

  } catch (err) {
    console.error('Profile country error:', err);
    res.status(500).json({ error: 'Failed to record country' });
  }
});

// ── POST /rate ─────────────────────────────────────────────────────────────────
app.post('/rate', rateLimiter, async (req, res) => {
  const { handle, rating, userId, posterCountry, posterCountrySource } = req.body;

  if (!handle || !rating || !userId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const h = handle.toLowerCase().replace('@', '');
  const trusted = rating === 'trust';

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const raterLocation = await getCountryFromIP(ip);

  try {
    const { error } = await supabase.from('ratings').upsert({
      handle: h,
      trusted,
      rater_country: raterLocation.name,
      rater_country_code: raterLocation.code,
      user_id: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'handle,user_id' });

    if (error) throw error;

    if (posterCountry && posterCountrySource === 'user_tag') {
      fetch(`http://localhost:${process.env.PORT || 3000}/profile-country`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: h, countryCode: posterCountry, source: 'user_tag', userId }),
      }).catch(() => {});
    }

    for (const key of cache.keys()) {
      if (key.startsWith(h + ':')) cache.delete(key);
    }

    res.json({ success: true, raterCountry: raterLocation.name, raterCountryCode: raterLocation.code });

  } catch (err) {
    console.error('Rating error:', err);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// ── POST /batch ────────────────────────────────────────────────────────────────
app.post('/batch', async (req, res) => {
  const { handles, raterCountries, noVpn, posterCountries } = req.body;

  if (!handles || !Array.isArray(handles) || handles.length === 0) {
    return res.status(400).json({ error: 'No handles provided' });
  }
  if (handles.length > 50) {
    return res.status(400).json({ error: 'Max 50 handles per batch' });
  }

  const hs = handles.map(h => h.toLowerCase().replace('@', ''));

  try {
    let ratingsQuery = supabase
      .from('ratings')
      .select('handle, trusted, rater_country_code')
      .in('handle', hs);

    if (raterCountries && raterCountries.length > 0) {
      ratingsQuery = ratingsQuery.in('rater_country_code', raterCountries);
    }

    const [ratingsRes, countriesRes] = await Promise.all([
      ratingsQuery,
      supabase.from('poster_countries').select('handle, country_code, source, confidence').in('handle', hs),
    ]);

    if (ratingsRes.error) throw ratingsRes.error;

    const posterCountryMap = {};
    (countriesRes.data || []).forEach(r => {
      posterCountryMap[r.handle] = { code: r.country_code, source: r.source, confidence: r.confidence };
    });

    const agg = {};
    hs.forEach(h => { agg[h] = { trust: 0, distrust: 0, byCountry: {} }; });

    (ratingsRes.data || []).forEach(r => {
      if (!agg[r.handle]) return;
      if (r.trusted) agg[r.handle].trust++;
      else agg[r.handle].distrust++;
      const cc = r.rater_country_code || 'XX';
      if (!agg[r.handle].byCountry[cc]) agg[r.handle].byCountry[cc] = { trust: 0, distrust: 0 };
      if (r.trusted) agg[r.handle].byCountry[cc].trust++;
      else agg[r.handle].byCountry[cc].distrust++;
    });

    const scores = hs.map(h => {
      const { trust, distrust, byCountry } = agg[h];
      const total = trust + distrust;
      const score = total > 0 ? Math.round((trust / total) * 100) : null;
      const pc = posterCountryMap[h];

      if (posterCountries && posterCountries.length > 0 && pc && !posterCountries.includes(pc.code)) {
        return null;
      }

      const breakdown = Object.entries(byCountry)
        .map(([country, v]) => ({ country, trust: v.trust, distrust: v.distrust }))
        .sort((a, b) => (b.trust + b.distrust) - (a.trust + a.distrust));

      return {
        handle: h,
        score,
        totalVotes: total,
        breakdown,
        cnCount: null,
        aiProb: null,
        posterCountry: pc?.code || null,
        posterCountrySource: pc?.source || null,
      };
    }).filter(Boolean);

    res.json({ scores });

  } catch (err) {
    console.error('Batch error:', err);
    res.status(500).json({ error: 'Batch fetch failed' });
  }
});

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, cacheSize: cache.size, uptime: Math.round(process.uptime()) });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TrustLayer backend v2 on port ${PORT}`));
