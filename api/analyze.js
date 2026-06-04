// ============================================================
// Hoxton Wealth — TikTok Content Hub
// api/analyze.js  |  Vercel Pro (60s timeout)
// Last updated: June 2026 — Noura
//
// WHAT THIS FILE DOES:
// 1. Searches TikTok by keyword via ScrapeCreators
// 2. Filters: 100K+ views AND 2K+ likes AND posted within 30 days
// 3. Fetches transcript (what creator actually says)
// 4. Sends to Gemini AI for full analysis + draft script idea
// 5. Returns results sorted by AI score
//
// ROADMAP:
// [x] Transcript: fetch what creator says, show on card
// [x] Date filter: only recent videos (last 30 days)
// [x] Better AI output: score, topic, audience fit, tone,
//     what they say, draft script idea, summary
// [ ] Weekly scan button: team clicks every Monday
// [ ] Download investigation (skipping for now - Vercel limitation)
// ============================================================

export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { keyword = 'financial planning', days = 30 } = req.body;
    const scrapeKey = process.env.SCRAPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    // ── STEP 1: Search TikTok ─────────────────────────────
    const response = await fetch(
      `https://api.scrapecreators.com/v1/tiktok/search/keyword?query=${encodeURIComponent(keyword)}`,
      { headers: { 'x-api-key': scrapeKey } }
    );
    const data = await response.json();
    const videos = data.search_item_list || [];

    // ── STEP 2: Filter ────────────────────────────────────
    // Keep only: 100K+ views AND 2K+ likes AND posted within `days` days
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const filtered = videos
      .map(item => {
        const info  = item.aweme_info || {};
        const stats = info.statistics || {};
        // TikTok timestamp is in seconds, convert to ms
        const postedAt = (info.create_time || 0) * 1000;
        return {
          author:    info.author?.nickname  || '',
          username:  info.author?.unique_id || '',
          video_id:  info.aweme_id          || '',
          desc:      info.desc              || '',
          views:     stats.play_count       || 0,
          likes:     stats.digg_count       || 0,
          comments:  stats.comment_count    || 0,
          shares:    stats.share_count      || 0,
          saves:     stats.collect_count    || 0,
          url:       info.url               || '',
          thumbnail: info.video?.cover?.url_list?.[0] || '',
          posted_at: postedAt,
          posted_label: postedAt
            ? new Date(postedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
            : 'Unknown date',
        };
      })
      .filter(v =>
        v.views >= 100000 &&
        v.likes >= 2000 &&
        (v.posted_at === 0 || v.posted_at >= cutoff) // keep if date unknown, filter old ones if date known
      );

    // ── STEP 3: Transcript + AI analysis ─────────────────
    const results = [];

    for (const v of filtered.slice(0, 5)) {

      // 3a. Fetch transcript
      let transcript     = '';
      let transcriptNote = 'Transcript unavailable — analysis based on caption only.';

      try {
        const tiktokUrl = `https://www.tiktok.com/@${v.username}/video/${v.video_id}`;
        const transcriptResp = await fetch(
          `https://api.scrapecreators.com/v1/tiktok/transcript?url=${encodeURIComponent(tiktokUrl)}&language=en`,
          { headers: { 'x-api-key': scrapeKey } }
        );
        const td = await transcriptResp.json();

        // Check all possible fields ScrapeCreators might return
        transcript =
          td.transcript ||
          td.text       ||
          td.subtitles  ||
          (Array.isArray(td.data) ? td.data.map(s => s.text || s.word || '').join(' ') : '') ||
          '';

        if (transcript && transcript.length > 20) {
          transcriptNote = transcript;
        }
      } catch (e) {
        console.log(`Transcript failed for ${v.video_id}:`, e.message);
      }

      const hasTranscript = transcript && transcript.length > 20;

      // 3b. AI prompt — analysis + draft script
      const prompt = `You are a senior content strategist for Hoxton Wealth, a financial planning firm for expats — professionals living outside their home country with complex cross-border financial needs (tax, pensions, investments, currency, inheritance).

Analyse this TikTok video and decide if it is worth adapting for Hoxton Wealth's audience.

── VIDEO DATA ──
Creator: @${v.author}
Caption: ${v.desc}
Posted: ${v.posted_label}
Views: ${v.views.toLocaleString()}
Likes: ${v.likes.toLocaleString()}
Comments: ${v.comments.toLocaleString()}
Shares: ${v.shares.toLocaleString()}
${hasTranscript
  ? `Full transcript (exactly what the creator said):\n"${transcript}"`
  : `Transcript: Not available. Base analysis on caption only and flag this.`
}

── WHAT TO RETURN ──
Reply ONLY as a flat JSON object. Every value must be a plain string. No nested objects. No arrays. No markdown. Use exactly these keys:

{
  "score": "<number 1-10 — how relevant is this for Hoxton Wealth expat audience>",
  "topic": "<specific financial topic covered, 1 sentence>",
  "audience_fit": "<does this match expats with complex needs? Mention expat angles: tax, pensions, currency if present>",
  "tone": "<is the tone professional enough for Hoxton Wealth? Note if too casual, too young, or well matched>",
  "what_they_say": "<${hasTranscript ? '2-3 sentence summary of the key points the creator actually says in the transcript' : 'Transcript unavailable — key points inferred from caption only'}>",
  "draft_script": "<A short draft script title and opening line Hoxton Wealth could use to film a similar video for expats. Format: TITLE: [title] | OPENING LINE: [first sentence the presenter would say]>",
  "summary": "<one sentence verdict: is this video useful as inspiration for Hoxton Wealth, and why>"
}`;

      // 3c. Send to Gemini via OpenRouter
      try {
        const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openrouterKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            max_tokens: 1200,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData  = await aiResponse.json();
        const rawText = aiData.choices?.[0]?.message?.content || '';
        const clean   = rawText.replace(/```json|```/g, '').trim();
        const parsed  = JSON.parse(clean);

        results.push({
          ...v,
          transcript:   transcriptNote,
          score:        parsed.score        || '5',
          topic:        parsed.topic        || 'Finance',
          audience_fit: parsed.audience_fit || 'Could not analyze',
          tone:         parsed.tone         || 'Could not analyze',
          what_they_say: parsed.what_they_say || transcriptNote,
          draft_script: parsed.draft_script || 'Could not generate',
          summary:      parsed.summary      || 'Analysis unavailable',
        });

      } catch (e) {
        console.log(`AI failed for ${v.video_id}:`, e.message);
        results.push({
          ...v,
          transcript:   transcriptNote,
          score:        '0',
          topic:        'Analysis failed',
          audience_fit: 'Could not analyze',
          tone:         'Could not analyze',
          what_they_say: transcriptNote,
          draft_script: 'Could not generate',
          summary:      'AI analysis failed — check OpenRouter key or try again',
        });
      }
    }

    results.sort((a, b) => Number(b.score) - Number(a.score));
    res.status(200).json(results);

  } catch (err) {
    console.error('Handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
