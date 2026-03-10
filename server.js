// TrustLayer backend — server.js
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());
app.use(cors());
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const generalLimiter = rateLimit({ windowMs: 60000, max: 120 });
const rateLimiter = rateLimit({ windowMs: 3600000, max: 50 });
app.use('/scores', generalLimiter);
app.use('/batch', generalLimiter);
app.use('/rate', rateLimiter);
const scoreCache = {};
const CACHE_TTL = 21600000;
function getCached(k) { const e = scoreCache[k]; if (!e) return null; if (Date.now()-e.ts>CACHE_TTL){delete scoreCache[k];return null;} return e.data; }
function setCache(k,d) { scoreCache[k]={ts:Date.now(),data:d}; }
async function computeScore(handle, raterCountries) {
    const key = handle+(raterCountries?.join(',')||'all');
    const cached = getCached(key);
    if (cached) return cached;
    let q = supabase.from('ratings').select('rating,country').eq('handle',handle.toLowerCase());
    if (raterCountries?.length) q = q.in('country',raterCountries);
    const { data: ratings, error } = await q;
    if (error) throw error;
    const totalVotes = ratings?.length||0;
    let score = null;
    if (totalVotes>0) score = Math.round(ratings.filter(r=>r.rating==='trust').length/totalVotes*100);
    const ago = new Date(Date.now()-7776000000).toISOString();
    const { data: cnData } = await supabase.from('community_notes').select('id',{count:'exact'}).eq('handle',handle.toLowerCase()).gte('created_at',ago);
    const result = { handle, score, totalVotes, cnCount: cnData?.length||0 };
    setCache(key,result);
    return result;
}
app.get('/scores/:handle', async (req,res) => {
    try { const rc=req.query.raters?req.query.raters.split(','):null; res.json(await computeScore(req.params.handle,rc)); } catch(e){res.status(500).json({error:e.message});}
});
app.post('/batch', async (req,res) => {
    try { const {handles,raterCountries}=req.body; if(!Array.isArray(handles)) return res.status(400).json({error:'handles required'}); const scores=await Promise.all(handles.slice(0,50).map(h=>computeScore(h,raterCountries))); res.json({scores}); } catch(e){res.status(500).json({error:e.message});}
});
app.post('/rate', async (req,res) => {
    try {
          cons// TrustLayer backend — server.js
  const express = require('express');
      const cors = require('cors');
      const rateLimit = require('express-rate-limit');
      const { createClient } = require('@supabase/supabase-js');
      const app = express();
      app.use(express.json());
      app.use(cors());
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
      const generalLimiter = rateLimit({ windowMs: 60000, max: 120 });
      const rateLimiter = rateLimit({ windowMs: 3600000, max: 50 });
      app.use('/scores', generalLimiter);
      app.use('/batch', generalLimiter);
      app.use('/rate', rateLimiter);
      const scoreCache = {};
      const CACHE_TTL = 21600000;
      function getCached(k) { const e = scoreCache[k]; if (!e) return null; if (Date.now()-e.ts>CACHE_TTL){delete scoreCache[k];return null;} return e.data; }
      function setCache(k,d) { scoreCache[k]={ts:Date.now(),data:d}; }
      async function computeScore(handle, raterCountries) {
          const key = handle+(raterCountries?.join(',')||'all');
          const cached = getCached(key);
          if (cached) return cached;
          let q = supabase.from('ratings').select('rating,country').eq('handle',handle.toLowerCase());
          if (raterCountries?.length) q = q.in('country',raterCountries);
          const { data: ratings, error } = await q;
          if (error) throw error;
          const totalVotes = ratings?.length||0;
          let score = null;
          if (totalVotes>0) score = Math.round(ratings.filter(r=>r.rating==='trust').length/totalVotes*100);
          const ago = new Date(Date.now()-7776000000).toISOString();
          const { data: cnData } = await supabase.from('community_notes').select('id',{count:'exact'}).eq('handle',handle.toLowerCase()).gte('created_at',ago);
          const result = { handle, score, totalVotes, cnCount: cnData?.length||0 };
          setCache(key,result);
          return result;
      }
      app.get('/scores/:handle', async (req,res) => {
          try { const rc=req.query.raters?req.query.raters.split(','):null; res.json(await computeScore(req.params.handle,rc)); } catch(e){res.status(500).json({error:e.message});}
      });
      app.post('/batch', async (req,res) => {
          try { const {handles,raterCountries}=req.body; if(!Array.isArray(handles)) return res.status(400).json({error:'handles required'}); const scores=await Promise.all(handles.slice(0,50).map(h=>computeScore(h,raterCountries))); res.json({scores}); } catch(e){res.status(500).json({error:e.message});}
      });
      app.post('/rate', async (req,res) => {
          try {
                const {handle,rating,userId}=req.body;
                if(!handle||!rating||!userId) return res.status(400).json({error:'missing fields'});
                if(!['trust','distrust'].includes(rating)) return res.status(400).json({error:'invalid rating'});
                const ip=(req.headers['x-forwarded-for']||'').split(',')[0]||req.ip;
                let country='UNKNOWN';
                try { const g=await(await fetch('http://ip-api.com/json/'+ip+'?fields=countryCode')).json(); country=g.countryCode||'UNKNOWN'; } catch(_){}
                const today=new Date().toISOString().split('T')[0];
                const {error}=await supabase.from('ratings').upsert({handle:handle.toLowerCase(),user_id:userId,rating,country,date:today,created_at:new Date().toISOString()},{onConflict:'handle,user_id,date'});
                if(error) throw error;
                Object.keys(scoreCache).forEach(k=>{if(k.startsWith(handle.toLowerCase()))delete scoreCache[k];});
                res.json({ok:true,country});
          } catch(e){res.status(500).json({error:e.message});}
      });
      app.get('/health',(_,res)=>res.json({ok:true,ts:Date.now()}));
      const PORT=process.env.PORT||3000;
      app.listen(PORT,()=>console.log('TrustLayer backend on port '+PORT));
