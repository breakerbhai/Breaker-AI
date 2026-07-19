// netlify/functions/chat.js
// Handles POST /api/chat -> routes to OpenAI, Gemini, or Groq depending on "model"
// Supports image analysis (Gemini + GPT-5) via an optional base64 "image" field.
// Supports image GENERATION via Gemini's image model when "mode": "image" is sent.
// All models follow the same "YouTube script master" persona below.
//
// SECURITY: every request must carry a valid Google ID token in the
// Authorization header (Authorization: Bearer <idToken>). This is the *real*
// gate — the login screen in index.html is just the UI; this check is what
// actually stops someone from calling the endpoint directly and burning your
// OpenAI/Gemini/Groq credits for free.

const SYSTEM_PROMPT = `You are an elite YouTube scriptwriting strategist and channel growth expert with 10+ years of experience writing viral, high-retention scripts and optimizing videos for the YouTube algorithm. You think like a mix of a professional editor, a retention-data analyst, and a copywriter.

Whenever the user asks for a script, hook, title, or content strategy, apply these principles automatically without being asked:

HOOKS (first 5-15 seconds):
- Open with a pattern interrupt, bold claim, question, or visual promise — never a slow intro.
- State exactly what the viewer will get and why it matters to them right now.

PACING:
- Vary sentence length and rhythm to avoid monotone delivery; short punchy lines for emphasis, longer lines for explanation.
- Flag natural cut points, b-roll moments, and pattern breaks every 20-40 seconds to fight retention drop-off.
- Warn about "dead zones" (slow, info-dump sections) and suggest how to compress or re-energize them.

OPEN LOOPS & CURIOSITY:
- Plant open loops early ("I'll show you exactly how in a second, but first...") and resolve them later to pull viewers through.
- Use curiosity gaps deliberately — tease outcomes, withhold key details briefly, ask rhetorical questions the viewer wants answered.
- Avoid closing every loop immediately; stack 2-3 open loops across a script for stronger mid-video retention.

STRUCTURE:
- Clear segments: Hook -> Setup/Stakes -> Payoff/Value -> Loop reinforcement -> CTA -> (optional) final curiosity tease for next video.
- End with a strong, non-generic call to action tied to the video's specific value.

TITLES & SEO:
- Suggest 3-5 title options balancing curiosity, clarity, and searchability.
- Keep primary keyword near the front, use numbers/specifics over vague language, avoid clickbait that the content doesn't deliver on.
- When asked, also suggest a matching thumbnail text concept (short, high-contrast, 3-5 words max).

FEEDBACK MODE:
- When reviewing a script or thumbnail the user provides, be direct and specific: point out exactly where the hook is weak, where pacing drags, where curiosity is missing, and give a rewritten example — not just abstract advice.

STRATEGY MODE:
- When asked for a content plan (e.g. "next 30 days"), structure it day-by-day or week-by-week with: video topic, hook angle, target curiosity gap, and estimated why-it-works reasoning based on what the user tells you about their channel/audience.
- If the user hasn't provided channel data (subscribers, past video performance), don't assume it — ask for it briefly or clearly state the plan is based on general best practices until real data is provided.

Always stay practical and specific. Give the user something they can literally read on camera or paste into a title field — not just theory.`;

// Set this in Netlify env vars too (Site settings -> Environment variables),
// same Client ID you put in index.html's GOOGLE_CLIENT_ID.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// Verifies a Google ID token by asking Google directly. No extra npm package
// needed (Netlify functions have fetch built in on modern runtimes).
async function verifyGoogleToken(idToken) {
  if (!idToken) return null;

  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!res.ok) return null;

  const payload = await res.json();

  // Token must be issued for THIS app's client ID, not expired, and the
  // email should be verified by Google.
  if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) return null;
  if (!payload.exp || Number(payload.exp) * 1000 < Date.now()) return null;
  if (payload.email_verified === "false") return null;

  return payload; // contains email, name, picture, etc.
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // --- Auth check: reject anything without a valid Google session ---
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const user = await verifyGoogleToken(idToken);

  if (!user) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Please sign in with Google to use the chat." })
    };
  }

  let message, model, image, mode;
  try {
    ({ message, model, image, mode } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!message && !image) {
    return { statusCode: 400, body: JSON.stringify({ error: "Message or image is required" }) };
  }

  try {
    // --- Image GENERATION request (the "generate image" toggle in the UI) ---
    // Only Gemini's image model is wired up for this, so any selected chat
    // model routes here the same way when mode === "image".
    if (mode === "image") {
      if (!message) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: "Please describe the image you want to generate." })
        };
      }
      const result = await callGeminiImageGen(message);
      return { statusCode: 200, body: JSON.stringify({ reply: result.text, image: result.image }) };
    }

    let reply;

    if (model === "gemini") {
      reply = await callGemini(message, image);
    } else if (model === "gpt5") {
      reply = await callOpenAI(message, image);
    } else if (model === "deepseek") {
      if (image) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "DeepSeek can't analyze images yet. Please switch to Gemini or GPT-5 to send images."
          })
        };
      }
      reply = await callGroq(message);
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Model "${model}" is not connected on the backend yet.` })
      };
    }

    return { statusCode: 200, body: JSON.stringify({ reply }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};

async function callOpenAI(message, image) {
  const content = [];
  if (message) content.push({ type: "text", text: message });
  if (image) content.push({ type: "image_url", image_url: { url: image } });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_KEY || process.env.CHATGPT_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: content.length ? content : (message || "") }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "OpenAI request failed");
  return data.choices?.[0]?.message?.content || "No response from OpenAI";
}

async function callGroq(message) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_KEY}`
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Groq request failed");
  return data.choices?.[0]?.message?.content || "No response from Groq";
}

async function callGemini(message, image) {
  const parts = [];
  if (message) parts.push({ text: message });

  if (image) {
    const match = image.match(/^data:(.+);base64,(.+)$/);
    if (match) {
      parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    }
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${process.env.GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts }]
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Gemini request failed");
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from Gemini";
}

// --- Image generation via Gemini's image model ("Nano Banana" family) ---
// Uses the same generateContent endpoint as text, but with a model that can
// return an inline image part when responseModalities includes "IMAGE".
async function callGeminiImageGen(message) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${process.env.GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: message }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Gemini image request failed");

  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = "";
  let imageDataUrl = null;

  for (const part of parts) {
    if (part.text) text += part.text;
    const inline = part.inlineData || part.inline_data;
    if (inline && inline.data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      imageDataUrl = `data:${mime};base64,${inline.data}`;
    }
  }

  if (!imageDataUrl) {
    throw new Error("Gemini didn't return an image for that prompt. Try rephrasing it.");
  }

  return { text: text || "Yeh raha aapka image!", image: imageDataUrl };
}
