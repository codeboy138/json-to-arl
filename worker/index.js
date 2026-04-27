export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
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

async function urlToBase64(url) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/jpeg";
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return `data:${mime};base64,${base64}`;
  } catch {
    return url; // 실패 시 원본 URL 유지
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