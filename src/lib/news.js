import axios from "axios";
import RssParser from "rss-parser";

export async function fetchRssNews(feeds, maxPerFeed = 10) {
  const parser = new RssParser({ requestOptions: { timeout: 10000 } });
  const items = [];
  for (const url of feeds) {
    try {
      const feed = await parser.parseURL(url);
      const source = feed.title || url;
      for (const entry of feed.items.slice(0, maxPerFeed)) {
        items.push({
          title:   entry.title || "",
          source,
          pubDate: entry.isoDate ? new Date(entry.isoDate) : null,
        });
      }
    } catch (err) {
      console.warn(`[WARN] RSS feed error (${url}): ${err.message}`);
    }
  }
  return items;
}

export async function fetchNewsApiNews(query, apiKey) {
  if (!apiKey) return [];
  try {
    const res = await axios.get("https://newsapi.org/v2/everything", {
      params: { q: query, language: "en", sortBy: "publishedAt", pageSize: 30, apiKey },
      timeout: 10000,
    });
    return res.data.articles.map((a) => ({
      title:   a.title || "",
      source:  a.source?.name || "NewsAPI",
      pubDate: a.publishedAt ? new Date(a.publishedAt) : null,
    }));
  } catch (err) {
    console.warn(`[WARN] NewsAPI error: ${err.message}`);
    return [];
  }
}

export async function fetchTrumpPosts() {
  const parser = new RssParser({ requestOptions: { timeout: 10000 } });
  const sources = [
    { url: "https://truthsocial.com/@realDonaldTrump.rss",      label: "Trump/TruthSocial" },
    { url: "https://nitter.privacydev.net/realDonaldTrump/rss", label: "Trump/X" },
    { url: "https://nitter.poast.org/realDonaldTrump/rss",      label: "Trump/X" },
    { url: "https://nitter.net/realDonaldTrump/rss",            label: "Trump/X" },
  ];
  for (const { url, label } of sources) {
    try {
      const feed = await parser.parseURL(url);
      const items = feed.items
        .slice(0, 15)
        .map((e) => ({
          title:   (e.title || e.contentSnippet || "").replace(/<[^>]+>/g, "").trim().slice(0, 280),
          source:  label,
          pubDate: e.isoDate ? new Date(e.isoDate) : null,
        }))
        .filter((i) => i.title.length > 5);
      if (items.length > 0) return items;
    } catch (_) { /* try next source */ }
  }
  console.warn("[WARN] Could not fetch Trump posts from any source.");
  return [];
}
