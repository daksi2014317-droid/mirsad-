import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: "24kb" }));
app.use(express.static(path.join(root, "public")));

app.get("/api/status", (_req, res) => {
  res.json({ ok: true, assistantConfigured: Boolean(process.env.GEMINI_API_KEY) });
});

const requestCounts = new Map();
app.post("/api/chat", async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "المساعد لم يُفعّل بعد. يحتاج إلى إعداد مفتاح Gemini في الخادم." });
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (requestCounts.get(ip) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 12) {
    return res.status(429).json({ error: "أرسلت أسئلة كثيرة خلال دقيقة. انتظر قليلًا ثم حاول مجددًا." });
  }
  recent.push(now);
  requestCounts.set(ip, recent);

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) {
    return res.status(400).json({ error: "صيغة المحادثة غير صحيحة." });
  }
  const contents = [];
  for (const message of messages) {
    if (!message || !["user", "model"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim() ||
        message.content.length > 2000) {
      return res.status(400).json({ error: "تحقق من نص السؤال ثم أعد المحاولة." });
    }
    contents.push({ role: message.role, parts: [{ text: message.content }] });
  }
  if (contents[contents.length - 1].role !== "user") {
    return res.status(400).json({ error: "أرسل سؤالًا جديدًا للمتابعة." });
  }

  try {
    const upstream = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "أنت نجم، مساعد فلكي تعليمي داخل موقع مِرصد. أجب باللغة العربية الواضحة والودودة، واشرح المفاهيم العلمية بدقة وبأسلوب مناسب للطلاب. ركّز على علم الفلك والفضاء، ويمكنك الإجابة عن الأسئلة العامة بإيجاز ثم إعادة توجيه الحوار إلى الفلك. لا تخترع مواعيد أو بيانات فلكية مباشرة؛ وضّح عندما تحتاج المعلومة إلى مصدر محدث. اجعل الإجابات منظمة ومختصرة، وشجّع الفضول والتفكير العلمي."
            }]
          },
          contents,
          generationConfig: { temperature: 0.6, maxOutputTokens: 700 }
        }),
        signal: AbortSignal.timeout(30_000)
      }
    );
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Gemini API request failed with status", upstream.status);
      if (upstream.status === 429) {
        return res.status(429).json({ error: "وصل المساعد إلى حد الاستخدام المؤقت. حاول بعد قليل." });
      }
      if (upstream.status === 400 || upstream.status === 403) {
        return res.status(502).json({ error: "تعذر استخدام مفتاح Gemini. راجع إعداد المفتاح وصلاحياته في Render." });
      }
      return res.status(502).json({ error: "خدمة الذكاء الاصطناعي لا تستجيب الآن. حاول لاحقًا." });
    }
    const reply = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("")
      .trim();
    if (!reply) {
      return res.status(502).json({ error: "لم يتمكن نجم من إنشاء إجابة. أعد صياغة السؤال." });
    }
    return res.json({ reply });
  } catch (error) {
    console.error("Gemini API connection error:", error.name);
    return res.status(502).json({ error: "تعذر الاتصال بخدمة الذكاء الاصطناعي. حاول مجددًا." });
  }
});

app.use((req, res) => res.sendFile(path.join(root, "public", "index.html")));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Mirsad listening on " + port));
