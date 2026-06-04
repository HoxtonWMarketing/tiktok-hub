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
    const { keyword = 'financial planning' } = req.body;
    const scrapeKey = process.env.SCRAPE_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    // Step 1 - Search TikTok
    const response = await fetch(
      `https://api.scrapecreators.com/v1/tiktok/search/keyword?query=${encodeURIComponent(keyword)}`,
      { headers: { 'x-api-key': scrapeKey } }
    );
    const data = await response.json();
    const videos = data.search_item_list || [];

    // Step 2 - Filter: 100K+ views AND 2K+ likes
    const filtered = videos
      .map(item => {
        const info = item.aweme_info || {};
        const stats = info.statistics || {};
        return {
          author: info.author?.nickname || '',
          username: info.author?.unique_id || '',
          video_id: info.aweme_id || '',
          desc: info.desc || '',
          views: stats.play_count || 0,
          likes: stats.digg_count || 0,
          comments: stats.comment_count || 0,
          shares: stats.share_count || 0,
          saves: stats.collect_count || 0,
          url: info.url || '',
          thumbnail: info.video?.cover?.url_list?.[0] || '',
        };
      })
      .filter(v => v.views >= 100000 && v.likes >= 2000);

    // Step 3 - Get transcript + analyze each video
    const results = [];
    for (const v of filtered.slice(0, 3)) {
      let transcript = '';

      try {
        const tiktokUrl = `https://www.tiktok.com/@${v.username}/video/${v.video_id}`;
        const transcriptResp = await fetch(
          `https://api.scrapecreators.com/v1/tiktok/transcript?url=${encodeURIComponent(tiktokUrl)}&language=en`,
          { headers: { 'x-api-key': scrapeKey } }
        );
        const transcriptData = await transcriptResp.json();
        transcript = transcriptData.transcript || transcriptData.text || '';
      } catch (e) {
        console.log('Transcript failed:', e.message);
      }

      // ---- FIXED PROMPT ----
      const prompt = `You are a content strategist for Hoxton Wealth, a financial planning company for expats.

Analyze this TikTok video:
Creator: @${v.author}
Caption: ${v.desc}
Views: ${v.views.toLocaleString()}
Likes: ${v.likes.toLocaleString()}
Comments: ${v.comments.toLocaleString()}
Shares: ${v.shares.toLocaleString()}
${transcript ? `Full Transcript of what was said: ${transcript}` : 'Transcript: Not available'}

Based on the caption and transcript give a thorough analysis. Reply ONLY as a flat JSON object with exactly these string fields:
{
  "score": <number 1-10, relevance for Hoxton Wealth expat audience>,
  "topic": "<what specific financial topic this covers>",
  "audience_fit": "<does this match expats with complex financial needs?>",
  "tone": "<is the tone professional enough for Hoxton Wealth?>",
  "visuals": "<describe the visual style, setting, editing based on what you know>",
  "content_idea": "<one specific idea for Hoxton Wealth to create a similar expat video>",
  "summary": "<one sentence: why this video is or isn't useful for Hoxton Wealth>"
}

All values must be plain strings. Do not nest objects. Do not add extra fields.`;
      // ---- END FIXED PROMPT ----

      try {
        const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openrouterKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            max_tokens: 1000,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData = await aiResponse.json();
        const text = aiData.choices?.[0]?.message?.content || '';
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        results.push({ ...v, ...parsed });
      } catch (e) {
        results.push({
          ...v,
          score: 5,
          topic: 'Finance',
          audience_fit: 'Could not analyze',
          tone: 'Could not analyze',
          visuals: 'Not available',
          content_idea: 'Could not analyze',
          summary: 'Analysis failed'
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    res.status(200).json(results);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
