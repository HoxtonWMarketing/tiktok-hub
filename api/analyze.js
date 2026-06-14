// ============================================================
// Hoxton Wealth — TikTok Content Hub
// api/analyze.js  |  Vercel Pro (60s timeout)
// WHISPER VERSION — June 2026 — Noura
//
// WHAT CHANGED FROM THE OLD VERSION:
// - Transcript no longer uses ScrapeCreators AI fallback (was 11 credits/video)
// - Now: take the video's MP4 URL (free, already in search results)
//        download the audio into memory
//        send it to Whisper via OpenRouter (~$0.006/video, 0 ScrapeCreators credits)
// - If Whisper fails for any video, falls back to caption-only analysis (never crashes)
//
// COST: 1 ScrapeCreators credit per search. That's it. No more 11-credit transcripts.
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
    const videos = data.search_item_list || [];

    // Capture how many ScrapeCreators credits are left after this search call.
    // The API returns credits_remaining in its response (per ScrapeCreators docs).
    const creditsRemaining = data.credits_remaining ?? 'unknown';
    console.log(`ScrapeCreators credits remaining after search: ${creditsRemaining}`);

    // ── STEP 2: Filter — 100K+ views, 2K+ likes, recent ──
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const filtered = videos
      .map(item => {
        const info  = item.aweme_info || {};
        const stats = info.statistics || {};
        const video = info.video || {};
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
          thumbnail: video.cover?.url_list?.[0] || '',
          // MP4 URL — already in the search results, free. Used for Whisper.
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

    for (const v of filtered.slice(0, 5)) {

      // 3a. Transcribe with Whisper via OpenRouter
      let transcript     = '';
      let transcriptNote = 'Transcript unavailable — analysis based on caption only.';

      if (v.mp4_url) {
        try {
          // Download the video into memory (no saving to disk)
          const videoResp = await fetch(v.mp4_url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Referer': 'https://www.tiktok.com/'
            }
          });

          if (videoResp.ok) {
            const arrayBuffer = await videoResp.arrayBuffer();
            const sizeMB = arrayBuffer.byteLength / (1024 * 1024);

            // Whisper limit is 25MB — skip if too big
            if (sizeMB <= 25) {
              const base64Audio = Buffer.from(arrayBuffer).toString('base64');

              // Send to Whisper via OpenRouter transcription endpoint
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
              }
            } else {
              console.log(`Video ${v.video_id} too big for Whisper: ${sizeMB.toFixed(1)}MB`);
            }
          }
        } catch (e) {
          console.log(`Whisper transcript failed for ${v.video_id}:`, e.message);
        }
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
