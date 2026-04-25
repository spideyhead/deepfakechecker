const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildPrompt(sourceDescription) {
  return `You are DeepTrace, an expert AI deepfake detection system. A user submitted ${sourceDescription} for forensic analysis.

Respond ONLY with a valid JSON object, no markdown, no extra text:

{
  "verdict": "FAKE" or "REAL" or "UNCERTAIN",
  "fake_probability": integer 0-100,
  "confidence": integer 50-99,
  "signals": [
    { "name": "facial coherence",    "score": 0-100, "risk": "high" or "mid" or "low" },
    { "name": "temporal artifacts",  "score": 0-100, "risk": "high" or "mid" or "low" },
    { "name": "compression pattern", "score": 0-100, "risk": "high" or "mid" or "low" },
    { "name": "eye blink rate",      "score": 0-100, "risk": "high" or "mid" or "low" },
    { "name": "lip sync accuracy",   "score": 0-100, "risk": "high" or "mid" or "low" },
    { "name": "metadata integrity",  "score": 0-100, "risk": "high" or "mid" or "low" }
  ],
  "explanation": "3-5 sentences of specific forensic reasoning"
}

Rules for scores:
- When REAL: facial coherence HIGH (80-99), metadata integrity HIGH (75-99), other signals LOW (5-30)
- When FAKE: facial coherence LOW (10-45), metadata integrity LOW (5-40), other signals HIGH (65-95)
- When UNCERTAIN: all signals in mid range (35-65)
- Make explanation technically specific and authentic.`;
}

async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) return resolve({ fields: {}, files: {} });

      const boundary = "--" + boundaryMatch[1];
      const parts = body.toString("binary").split(boundary);
      const fields = {};
      const files = {};

      for (const part of parts) {
        if (part === "--\r\n" || part.trim() === "--") continue;
        const [rawHeaders, ...rawBodyParts] = part.split("\r\n\r\n");
        if (!rawHeaders) continue;
        const rawBody = rawBodyParts.join("\r\n\r\n").replace(/\r\n$/, "");
        const nameMatch = rawHeaders.match(/name="([^"]+)"/);
        const fileMatch = rawHeaders.match(/filename="([^"]+)"/);
        const mimeMatch = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i);
        if (!nameMatch) continue;
        const fieldName = nameMatch[1];
        if (fileMatch) {
          files[fieldName] = {
            filename: fileMatch[1],
            mimetype: mimeMatch ? mimeMatch[1].trim() : "application/octet-stream",
            buffer: Buffer.from(rawBody, "binary"),
          };
        } else {
          fields[fieldName] = rawBody;
        }
      }
      resolve({ fields, files });
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const contentType = req.headers["content-type"] || "";
    let messageContent;

    if (contentType.includes("multipart/form-data")) {
      const { files, fields } = await parseMultipart(req);

      if (files.video) {
        const { filename, mimetype, buffer } = files.video;
        const kb = (buffer.length / 1024).toFixed(1);
        const base64 = buffer.toString("base64");
        const isImage = mimetype.startsWith("image/");

        if (isImage) {
          messageContent = [
            { type: "image", source: { type: "base64", media_type: mimetype, data: base64 } },
            { type: "text", text: buildPrompt(`an image file named "${filename}"`) },
          ];
        } else {
          messageContent = [
            { type: "text", text: buildPrompt(`a video file named "${filename}" (${kb} KB, type: ${mimetype})`) },
          ];
        }
      } else if (fields.url) {
        messageContent = [
          { type: "text", text: buildPrompt(`a video from URL: ${fields.url}`) },
        ];
      } else {
        return res.status(400).json({ error: "No file or URL provided." });
      }

    } else if (contentType.includes("application/json")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (!body.url) return res.status(400).json({ error: "No URL provided." });
      messageContent = [
        { type: "text", text: buildPrompt(`a video from URL: ${body.url}`) },
      ];
    } else {
      return res.status(400).json({ error: "Unsupported content type." });
    }

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: messageContent }],
    });

    const raw = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .replace(/```json|```/g, "")
      .trim();

    const result = JSON.parse(raw);
    return res.status(200).json({ success: true, result });

  } catch (err) {
    console.error("DeepTrace error:", err);
    return res.status(500).json({ error: err.message || "Analysis failed." });
  }
};
