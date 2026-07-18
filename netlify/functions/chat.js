// netlify/functions/chat.js
// Handles POST /api/chat -> routes to OpenAI, Gemini, or Groq depending on "model"
// Now also supports image analysis (Gemini + GPT-5) via an optional base64 "image" field.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let message, model, image;
  try {
    ({ message, model, image } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!message && !image) {
    return { statusCode: 400, body: JSON.stringify({ error: "Message or image is required" }) };
  }

  try {
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
      messages: [{ role: "user", content: content.length ? content : (message || "") }]
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
      messages: [{ role: "user", content: message }]
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
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Gemini request failed");
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response from Gemini";
}

