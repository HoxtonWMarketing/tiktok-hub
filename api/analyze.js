// ============================================================
// Hoxton Wealth — TikTok Content Hub
// api/analyze.js  |  Vercel Pro (60s timeout)
// WHISPER + FFMPEG VERSION — June 2026 — Noura
// ============================================================

import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export const config = {
  maxDuration: 60
};

// Strip audio from a video buffer into a small MP3 using ffmpeg.
async function extractAudioMp3(videoBuffer, id) {
  const inPath  = join(tmpdir(), `in_${id}.mp4`);
  const outPath = join(tmpdir(), `out_${id}.mp3`);
  await writeFile(inPath, videoBuffer);

  await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-i', inPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
      '-f', 'mp3', outPath, '-y'
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
    ff.on('error', reject);
  });

  const mp3 = await readFile(outPath);
  unlink(inPath).catch(() => {});
  unlink(outPath).catch(() => {});
  return mp3;
}

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
    const videos = data.search_item_list || data.aweme_list || data.items || [];
    const totalFound = videos.length; 
    console.log(`[FILTER] search returned ${totalFound} videos`);

    const creditsRemaining = (data.credits_remaining !== undefined && data.credits_remaining !== null) ? data.credits_remaining : 'unknown';
    console.log(`ScrapeCreators credits remaining after search: ${creditsRemaining}`);

    // ── STEP 2: Map Raw Data ──────────────────────────────
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const mappedVideos = videos.map(item => {
      const info  = item.aweme_info || item;
      const stats = info.statistics || {};
      const video = info.video || {};
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
    });

    // ── STEP 3: Dynamic Fallback Filter Logic ──────────────
    // Defines tiered thresholds if the main criteria returns too few videos.
    const filterTiers = [
      { minViews: 50000, minLikes: 500 }, // Tier 1: Original strict setting
      { minViews: 20000, minLikes: 200 }, // Tier 2: Mid-tier content
      { minViews: 5000,  minLikes: 50  }, // Tier 3: Low-tier but relevant niche content
      { minViews: 0,     minLikes: 0   }  // Tier 4: Panic mode, take anything matching keyword
    ];

    let filtered = [];
    let appliedTier = 0;

    for (let i = 0; i < filterTiers.length; i++) {
      const tier = filterTiers[i];
      filtered = mappedVideos.filter(v =>
        v.views >= tier.minViews &&
        v.likes >= tier.minLikes &&
        (v.posted_at === 0 || v.posted_at >= cutoff)
      );

      if (filtered.length >= 5 || i === filterTiers.length - 1) {
        appliedTier = i + 1;
        break;
      }
    }

    console.log(`[FILTER] Tier ${appliedTier} applied. ${filtered.length} of ${totalFound} videos passed.`);

    // Limit to top 5 or whatever your display max is
    const finalSelection = filtered.slice(0, 5);

    // ── STEP 4: Process Selected Videos (Batching) ────────
    // (Your remaining batch execution code, Whisper API calls, and Gemini analysis continue here safely using finalSelection...)
    
    // placeholder return to keep compiler happy during review
    return res.status(200).json({ success: true, count: finalSelection.length, data: finalSelection });

  } catch (error) {
    console.error("Critical error in handler:", error);
    return res.status(500).json({ error: error.message });
  }
}
