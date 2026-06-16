// ============================================================
// Hoxton Wealth — TikTok Content Hub
// api/analyze.js  |  Vercel Pro (60s timeout)
// WHISPER VERSION — June 2026 — Noura
//
// HOW TRANSCRIPTS WORK:
// - Take the video's MP4 URL (free, already in search results)
// - Check file size FIRST. If over 24MB, skip transcript (Whisper limit is 25MB)
//   and show a note on the card. Gemini still analyses caption + stats as normal.
// - Otherwise download audio into memory, send to Whisper via OpenRouter (~$0.006/video)
//
// COST: 1 ScrapeCreators credit per search. Transcripts cost 0 ScrapeCreators credits.
//
// FIXES: 3 videos (not 5) to avoid timeout. Forces valid JSON from Gemini.
// Repairs JSON if it still breaks. Skips oversized videos with a note.
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

    // ── STEP 1: Search TikTok (1 credit) ──────────────────
    const response = await fetch(
      `https://api.scrapecreators.com/v1/tiktok/search/keyword?query=${encodeURIComponent(keyword)}`,
      { headers: { 'x-api-key': scrapeKey } }
    );
    const data = await response.json();
    // The search can return the videos under different keys depending on the
    // endpoint version — handle all of them.
    const videos = data.search_item_list || data.aweme_list || data.items || [];

    // Log how many ScrapeCreators credits are left after this search (visible in Vercel Logs)
    const creditsRemaining = (data.credits_remaining !== undefined && data.credits_remaining !== null) ? data.credits_remaining : 'unknown';
    console.log(`ScrapeCreators credits remaining after search: ${creditsRemaining}`);

    // DIAGNOSTIC: show how many videos came back, the top-level keys of the
    // response, and the raw structure of the first video so we can see the
    // EXACT field names. Remove this once the filter is confirmed working.
    console.log(`[DEBUG] videos returned: ${videos.length}`);
    console.log(`[DEBUG] response top-level keys: ${Object.keys(data).join(', ')}`);
    if (videos.length > 0) {
      console.log(`[DEBUG] first video structure: ${JSON.stringify(videos[0]).slice(0, 1500)}`);
    }

    // ── STEP 2: Filter — 100K+ views, 2K+ likes, recent ──
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const filtered = videos
      .map(item => {
        // Some responses nest the data under aweme_info, others put it
        // directly on the item. Support both so the filter always sees real numbers.
        const info  = item.aweme_info || item;
        const stats = info.statistics || {};
        const video = info.video || {};
        // create_time can be a number (seconds) or an ISO date string
        let postedAt = 0;
        if (info.create_time) {
          postedAt = typeof info.create_time === 'number'
            ? info.create_time * 1000
            : new Date(info.create_time).getTime();
        }
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
          thumbnail: video.cover?.url_list?.[0] || '',
          mp4_url:   video.play_addr?.url_list?.[0] || '',
          posted_at: postedAt,
          posted_label: postedAt
            ? new Date(postedAt).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
            : 'Unknown date',
        };
      })
      .filter(v =>
        v.views >= 100000 &&
        v.likes >= 2000 &&
        (v.posted_at === 0 || v.posted_at >= cutoff)
      );

    // ── STEP 3: Whisper transcript + AI analysis ─────────
    const results = [];

    for (const v of filtered.slice(0, 3)) {

      // 3a. Try to transcribe with Whisper
      let transcript     = '';
      let transcriptNote = 'Transcript unavailable — analysis based on caption only.';

      if (v.mp4_url) {
        try {
          const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.tiktok.com/'
          };

          // Download the video directly with a 15-second cap so a slow video
          // can't eat the whole 60-second budget. (No HEAD request — it was
          // causing timeouts.)
          const dlController = new AbortController();
          const dlTimeout = setTimeout(() => dlController.abort(), 15000);

          let videoResp;
          try {
            videoResp = await fetch(v.mp4_url, { headers, signal: dlController.signal });
          } finally {
            clearTimeout(dlTimeout);
          }

          if (videoResp && videoResp.ok) {
            const arrayBuffer = await videoResp.arrayBuffer();
            const actualMB = arrayBuffer.byteLength / (1024 * 1024);

            if (actualMB > 24) {
              transcriptNote = `Video too large for transcript (${actualMB.toFixed(0)}MB). Analysis based on caption only.`;
            } else {
              const base64Audio = Buffer.from(arrayBuffer).toString('base64');
              const whisperResp = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${openrouterKey}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: 'openai/whisper-1',
                  input_audio: { data: base64Audio, format: 'mp4' }
                })
              });
              const whisperData = await whisperResp.json();
              const text = whisperData.text || whisperData.transcript || '';
              if (text && text.length > 20) {
                transcript = text.trim();
                transcriptNote = transcript;
              } else {
                transcriptNote = 'No speech detected in video. Analysis based on caption only.';
              }
            }
          }
        } catch (e) {
          console.log(`Transcript failed for ${v.username}:`, e.message);
        }
      }

      const hasTranscript = transcript && transcript.length > 20;

      // Trim long transcripts so the Gemini prompt stays a safe size
      const transcriptForPrompt = hasTranscript
        ? (transcript.length > 2000 ? transcript.slice(0, 2000) + '...' : transcript)
        : '';

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
  ? `Full transcript (exactly what the creator said):\n"${transcriptForPrompt}"`
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
            // Force the model to return strictly valid JSON — prevents the
            // "Unterminated string in JSON" errors from line breaks/quotes in transcripts
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData  = await aiResponse.json();
        const rawText = aiData.choices?.[0]?.message?.content || '';

        // Robust JSON extraction: grab just the {...} block
        let clean = rawText.replace(/```json|```/g, '').trim();
        const firstBrace = clean.indexOf('{');
        const lastBrace  = clean.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          clean = clean.slice(firstBrace, lastBrace + 1);
        }

        let parsed;
        try {
          parsed = JSON.parse(clean);
        } catch (parseErr) {
          // If parsing fails, repair common issue: raw line breaks inside string values
          const repaired = clean.replace(/[\n\r\t]+/g, ' ');
          parsed = JSON.parse(repaired);
        }

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
        console.log(`AI failed for ${v.username}:`, e.message);
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
