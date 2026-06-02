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

    // Step 2 - Filter first
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

    // Step 3 - Download and analyze each video
    const results = [];
    for (const v of filtered.slice(0, 3)) {
      let videoBase64 = null;

      try {
        // Try downloading via ytdlp-web serverless API
        const tiktokUrl = `https://www.tiktok.com/@${v.username}/video/${v.video_id}`;
        const downloadResp = await fetch(
          `https://yozora.vercel.app/api/download?url=${encodeURIComponent(tiktokUrl)}&format=mp4`,
          { signal: AbortSignal.timeout(20000) }
        );

        if (downloadResp.ok) {
          const videoBuffer = await downloadResp.arrayBuffer();
          videoBase64 = Buffer.from(videoBuffer).toString('base64');
        }
      } catch (e) {
        console.log('Download failed, using caption only:', e.message);
      }

      // Build AI message
      let aiContent;
      if (videoBase64) {
        aiContent = [
          {
            type: 'image_url',
            image_url: { url: `data:video/mp4;base64,${videoBase64}` }
          },
          {
            type: 'text',
            text: `You are a content strategist for Hoxton Wealth, a financial planning company for expats.

Watch this TikTok video carefully and analyze everything you see:
Creator: @${v.author}
Caption: ${v.desc}
Views: ${v.views.toLocaleString()}
Likes: ${v.likes.toLocaleString()}

Analyze:
1. SCORE (1-10): Relevance for Hoxton Wealth expat audience
2. TOPIC: What financial topic does this cover?
3. AUDIENCE FIT: Does this match expats with complex financial needs?
4. TONE: Is the tone professional enough for Hoxton Wealth?
5. VISUALS: Describe exactly what you SEE — the person, background, setting, clothing, style
6. CONTENT IDEA: Specific idea for Hoxton Wealth to create a similar expat video
7. SUMMARY: One sentence summary

Reply ONLY as JSON:
{"score": number, "topic": "string", "audience_fit": "string", "tone": "string", "visuals": "string", "content_idea": "string", "summary": "string"}`
          }
        ];
      } else {
        aiContent = `You are a content strategist for Hoxton Wealth, a financial planning company for expats.
Analyze this TikTok:
Creator: @${v.author}
Caption: ${v.desc}
Views: ${v.views.toLocaleString()}, Likes: ${v.likes.toLocaleString()}

Reply ONLY as JSON:
{"score": number, "topic": "string", "audience_fit": "string", "tone": "string", "visuals": "Video could not be downloaded", "content_idea": "string", "summary": "string"}`;
      }

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
            messages: [{ role: 'user', content: aiContent }]
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
          visuals: 'Could not analyze',
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
