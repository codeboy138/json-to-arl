import puppeteer from "@cloudflare/puppeteer";

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === "/search" && request.method === "GET") {
      return handleSearch(request, env, corsHeaders);
    }

    if (path === "/screenshot" && request.method === "POST") {
      return handleScreenshot(request, env, corsHeaders);
    }

    if (path === "/pexels-url" && request.method === "POST") {
      return handlePexelsByUrl(request, env, corsHeaders);
    }

    // ── 이미지 프록시: CORS를 허용하지 않는 이미지 URL을 서버사이드에서 fetch → base64 반환 ──
    if (path === "/proxy" && request.method === "POST") {
      return handleProxy(request, env, corsHeaders);
    }

    // ── 스톡 이미지 페이지 URL → 실제 이미지 URL 변환 (Pexels/Unsplash/Pixabay 통합) ──
    if (path === "/resolve-image" && request.method === "POST") {
      return handleResolveImage(request, env, corsHeaders);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const json = await request.json();
      const converted = await replaceImageUrls(json);
      return new Response(JSON.stringify(converted), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};

// ── 스톡 이미지 페이지 URL → 실제 이미지 URL 변환 ──
// service: 'pexels' | 'unsplash' | 'pixabay'
async function handleResolveImage(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); }
  catch { return jsonErr("Invalid JSON", 400, corsHeaders); }

  const { url, service } = body;
  if (!url) return jsonErr("url 필드가 필요합니다", 400, corsHeaders);

  try {
    let imageUrl;

    // ── Pexels ──
    if (service === "pexels") {
      if (!env.PEXELS_KEY) return jsonErr("PEXELS_KEY not set", 500, corsHeaders);
      const match = url.match(/\/(\d+)\/?(?:\?.*)?$/);
      if (!match) return jsonErr("Pexels: photo ID 추출 실패", 400, corsHeaders);
      const r = await fetch(`https://api.pexels.com/v1/photos/${match[1]}`, {
        headers: { Authorization: env.PEXELS_KEY },
      });
      if (!r.ok) return jsonErr(`Pexels API ${r.status}`, 502, corsHeaders);
      const d = await r.json();
      imageUrl = d.src?.large || d.src?.original || d.src?.medium;
    }

    // ── Unsplash ──
    else if (service === "unsplash") {
      if (!env.UNSPLASH_KEY) return jsonErr("UNSPLASH_KEY not set", 500, corsHeaders);
      // URL 형식: https://unsplash.com/photos/<id>
      const match = url.match(/\/photos\/([A-Za-z0-9_-]+)/);
      if (!match) return jsonErr("Unsplash: photo ID 추출 실패", 400, corsHeaders);
      const r = await fetch(`https://api.unsplash.com/photos/${match[1]}?client_id=${env.UNSPLASH_KEY}`);
      if (!r.ok) return jsonErr(`Unsplash API ${r.status}`, 502, corsHeaders);
      const d = await r.json();
      imageUrl = d.urls?.regular || d.urls?.full || d.urls?.raw;
    }

    // ── Pixabay ──
    else if (service === "pixabay") {
      if (!env.PIXABAY_KEY) return jsonErr("PIXABAY_KEY not set", 500, corsHeaders);
      // URL 형식: https://pixabay.com/photos/title-<id>/  또는  /images/title-<id>/
      const match = url.match(/-(\d+)\/?(?:\?.*)?$/);
      if (!match) return jsonErr("Pixabay: photo ID 추출 실패", 400, corsHeaders);
      const r = await fetch(
        `https://pixabay.com/api/?key=${env.PIXABAY_KEY}&id=${match[1]}`
      );
      if (!r.ok) return jsonErr(`Pixabay API ${r.status}`, 502, corsHeaders);
      const d = await r.json();
      const hit = d.hits?.[0];
      if (!hit) return jsonErr("Pixabay: 이미지를 찾을 수 없습니다", 404, corsHeaders);
      imageUrl = hit.largeImageURL || hit.webformatURL;
    }

    else {
      return jsonErr("알 수 없는 service: " + service, 400, corsHeaders);
    }

    if (!imageUrl) return jsonErr("이미지 URL을 찾을 수 없습니다", 404, corsHeaders);

    return new Response(JSON.stringify({ imageUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    return jsonErr(e.message, 502, corsHeaders);
  }
}

function jsonErr(msg, status, corsHeaders) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── 이미지 프록시 핸들러 ──
// 클라이언트가 직접 fetch할 수 없는 이미지(CORS 차단)를 Worker에서 대신 가져와 base64로 반환
async function handleProxy(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { url } = body;
  if (!url || typeof url !== "string") {
    return new Response(JSON.stringify({ error: "url 필드가 필요합니다" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const dataUrl = await urlToBase64(url);
    const mime = dataUrl.split(";")[0].replace("data:", "");
    return new Response(JSON.stringify({ dataUrl, mime }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ── 스크린샷 핸들러 ──
async function handleScreenshot(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const urls = Array.isArray(body.urls)
    ? body.urls
    : body.url
    ? [body.url]
    : [];

  if (!urls.length) {
    return new Response(JSON.stringify({ error: "No URLs provided" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results = await Promise.all(
    urls.map(u => takeScreenshot(env.BROWSER, u))
  );

  return new Response(JSON.stringify(results), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function takeScreenshot(browser, url) {
  try {
    if (!url.startsWith("http")) url = "https://" + url;

    const instance = await puppeteer.launch(browser);
    const page = await instance.newPage();

    await page.setViewport({
      width: 1280,
      height: 800,
      deviceScaleFactor: 2,
    });

    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 25000,
    });

    const png = await page.screenshot({
      type: "png",
      fullPage: false,
      encoding: "base64",
    });

    await instance.close();

    return { url, success: true, png: `data:image/png;base64,${png}` };

  } catch (err) {
    return { url, success: false, error: err.message };
  }
}

// ── Pexels URL → 원본 이미지 ──
async function handlePexelsByUrl(request, env, corsHeaders) {
  const { urls } = await request.json();

  const results = await Promise.all(urls.map(async (url) => {
    const match = url.match(/\/(\d+)\/?$/);
    if (!match) return { url, error: "ID 추출 실패" };

    const id = match[1];
    const r = await fetch(`https://api.pexels.com/v1/photos/${id}`, {
      headers: { Authorization: env.PEXELS_KEY }
    });

    if (!r.ok) return { url, error: `Pexels API ${r.status}` };

    const data = await r.json();
    return {
      url,
      id,
      original: data.src.original,
      large: data.src.large,
      medium: data.src.medium,
      alt: data.alt,
    };
  }));

  return new Response(JSON.stringify(results), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── 기존 함수들 ──
async function urlToBase64(url) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/jpeg";
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return `data:${mime};base64,${base64}`;
  } catch {
    return url;
  }
}

async function replaceImageUrls(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) {
    return Promise.all(obj.map(replaceImageUrls));
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "src" && typeof value === "string" && value.startsWith("http")) {
      result[key] = await urlToBase64(value);
    } else {
      result[key] = await replaceImageUrls(value);
    }
  }
  return result;
}

async function handleSearch(request, env, corsHeaders) {
  const u       = new URL(request.url);
  const source  = u.searchParams.get("source");
  const q       = u.searchParams.get("q") || "";
  const page    = parseInt(u.searchParams.get("page") || "1");
  const perPage = Math.min(parseInt(u.searchParams.get("per_page") || "15"), 30);

  const ok  = d => new Response(JSON.stringify(d), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const err = (m, s = 502) => new Response(JSON.stringify({ error: m }), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    if (source === "unsplash") {
      if (!env.UNSPLASH_KEY) return err("Unsplash key not set", 500);
      const r = await fetch(
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&client_id=${env.UNSPLASH_KEY}`
      );
      if (!r.ok) return err(`Unsplash ${r.status}`);
      const d = await r.json();
      return ok((d.results || []).map(p => ({
        src: "unsplash", thumb: p.urls.small, full: p.urls.regular,
        alt: p.alt_description || q, author: p.user?.name || "", link: p.links?.html || "",
      })));
    }

    if (source === "pexels") {
      if (!env.PEXELS_KEY) return err("Pexels key not set", 500);
      const r = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}`,
        { headers: { Authorization: env.PEXELS_KEY } }
      );
      if (!r.ok) return err(`Pexels ${r.status}`);
      const d = await r.json();
      return ok((d.photos || []).map(p => ({
        src: "pexels", thumb: p.src.medium, full: p.src.large,
        alt: p.alt || q, author: p.photographer || "", link: p.url || "",
      })));
    }

    if (source === "pixabay") {
      if (!env.PIXABAY_KEY) return err("Pixabay key not set", 500);
      const r = await fetch(
        `https://pixabay.com/api/?key=${env.PIXABAY_KEY}&q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&image_type=photo&safesearch=true`
      );
      if (!r.ok) return err(`Pixabay ${r.status}`);
      const d = await r.json();
      return ok((d.hits || []).map(p => ({
        src: "pixabay", thumb: p.previewURL, full: p.webformatURL,
        alt: p.tags || q, author: p.user || "", link: p.pageURL || "",
      })));
    }

    return err("Unknown source", 400);
  } catch (e) {
    return err(e.message);
  }
}