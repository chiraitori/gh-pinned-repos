import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import LRU from "https://esm.sh/quick-lru@6.1.1";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";

interface PinnedRepo {
  owner: string;
  repo: string;
  link: string;
  description?: string;
  image: string;
  website?: string;
  language?: string;
  languageColor?: string;
  stars: number;
  forks: number;
}

const cache = new LRU<string, PinnedRepo[]>({
  maxSize: 500,
});

async function fetchWithTimeout(url: string, timeout = 5000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, { 
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadHTML(url: string): Promise<cheerio.CheerioAPI> {
  try {
    const response = await fetchWithTimeout(url);
    const html = await response.text();
    return cheerio.load(html);
  } catch (error) {
    console.error(`Failed to load URL: ${url}`, error);
    throw new Error(`Failed to load URL: ${url}`);
  }
}

async function getPinnedRepos(username: string): Promise<PinnedRepo[]> {
  const $ = await loadHTML(`https://github.com/${username}`);
  const pinnedItems = $('.js-pinned-items-reorder-list > li').toArray();

  if (!pinnedItems.length) {
    return [];
  }

  const repos: PinnedRepo[] = await Promise.all(
    pinnedItems.map(async (item) => {
      const $item = $(item);
      
      // Get repo name from the title element
      const repo = $item.find('[class*="repo"]').text().trim();
      
      // Updated selector for description using the exact class
      const description = $item.find('.pinned-item-desc').text().trim();
      
      // Get language
      const language = $item.find('[class*="language-color"]').next().text().trim();
      const languageColor = $item.find('[class*="language-color"]').css('background-color');

      // Get stars and forks
      const stars = parseNumericValue($item.find('a[href*="/stargazers"]').text().trim());
      const forks = parseNumericValue($item.find('a[href*="/forks"]').text().trim());

      return {
        owner: username,
        repo,
        link: `https://github.com/${username}/${repo}`,
        description: description || undefined,
        image: `https://opengraph.githubassets.com/1/${username}/${repo}`,
        website: await getRepoWebsite(`https://github.com/${username}/${repo}`),
        language: language || undefined,
        languageColor: languageColor || undefined,
        stars,
        forks,
      };
    })
  );

  return repos;
}

async function getRepoWebsite(repoUrl: string): Promise<string | undefined> {
  try {
    const $ = await loadHTML(repoUrl);
    const website = $('[class*="BorderGrid-cell"] a[href^="https"]').first().attr("href");
    return website?.trim();
  } catch (error) {
    console.error(`Failed to get website for repo: ${repoUrl}`, error);
    return undefined;
  }
}

function parseNumericValue(value: string): number {
  if (!value) return 0;
  const normalized = value.toLowerCase().trim();
  
  if (normalized.endsWith('k')) {
    return Math.round(parseFloat(normalized.slice(0, -1)) * 1000);
  }
  return parseInt(normalized, 10) || 0;
}

async function handler(request: Request): Promise<Response> {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Request-Method": "*",
    "Access-Control-Allow-Methods": "OPTIONS, GET",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "public, max-age=600",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  const url = new URL(request.url);
  const username = url.searchParams.get("username");
  const refresh = url.searchParams.get("refresh") === "true";

  if (!username) {
    return new Response(
      `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>GitHub Pinned Repos API</title>
          <style>
            body { font-family: system-ui; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
            input, button { padding: 0.5rem; font-size: 1rem; }
          </style>
        </head>
        <body>
          <h1>GitHub Pinned Repos API</h1>
          <form action="/">
            <input type="text" name="username" placeholder="GitHub username" required>
            <button type="submit">Get Repos</button>
          </form>
          <p>GET /?username=GITHUB_USERNAME&refresh=true|false</p>
        </body>
      </html>`,
      { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  try {
    let result: PinnedRepo[];
    
    if (!refresh && cache.has(username)) {
      result = cache.get(username)!;
      getPinnedRepos(username)
        .then(data => cache.set(username, data))
        .catch(console.error);
    } else {
      result = await getPinnedRepos(username);
      cache.set(username, result);
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: { ...headers, "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error(`Error processing request for username: ${username}`, error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch pinned repositories", details: error.message }),
      { status: 500, headers: { ...headers, "Content-Type": "application/json" } }
    );
  }
}

const port = parseInt(Deno.env.get("PORT") || "80");
const hostname = "0.0.0.0"; // Required for Deno Deploy

serve(handler, { port, hostname });
console.log(`Server running on http://${hostname}:${port}`);
