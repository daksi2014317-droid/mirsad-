import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: "24kb" }));
app.use(express.static(path.join(root, "public")));

app.get("/api/status", (_req, res) => {
  res.json({ ok: true, assistantConfigured: Boolean(process.env.HF_TOKEN) });
});

const requestCounts = new Map();
app.post("/api/chat", async (req, res) => {
  if (!process.env.HF_TOKEN) {
    return res.status(503).json({ error: "نجم ينتظر تفعيل اتصال الذكاء الاصطناعي. أضف رمز Hugging Face إلى إعدادات الخادم." });
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (requestCounts.get(ip) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 6) {
    return res.status(429).json({ error: "أرسلت أسئلة كثيرة خلال دقيقة. انتظر قليلًا ثم حاول مجددًا." });
  }
  recent.push(now);
  requestCounts.set(ip, recent);

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) {
    return res.status(400).json({ error: "صيغة المحادثة غير صحيحة." });
  }

  const conversation = [];
  for (const message of messages) {
    if (!message || !["user", "model", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim() ||
        message.content.length > 2000) {
      return res.status(400).json({ error: "تحقق من نص السؤال ثم أعد المحاولة." });
    }
    conversation.push({
      role: message.role === "model" ? "assistant" : message.role,
      content: message.content
    });
  }
  if (conversation[conversation.length - 1].role !== "user") {
    return res.status(400).json({ error: "أرسل سؤالًا جديدًا للمتابعة." });
  }

  try {
    const upstream = await fetch("https://router.huggingface.co/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "Qwen/Qwen3-4B-Thinking-2507:fastest",
        messages: [
          {
            role: "system",
            content: "أنت نجم، مساعد فلكي تعليمي في موقع مِرصد. أجب بالعربية الواضحة، واشرح علم الفلك والفضاء بدقة وبأسلوب مناسب للطلاب. أعط إجابات مفهومة ومنظمة ومختصرة. لا تخترع حقائق أو أرقامًا أو مواعيد للأحداث الفلكية. إذا لم تكن متأكدًا أو كانت المعلومة تحتاج بيانات حديثة، فقل ذلك بوضوح ولا تتظاهر بالمعرفة. فرّق بين الحقائق العلمية الراسخة والتوقعات أو الفرضيات. يمكنك الإجابة عن الأسئلة العامة بإيجاز، مع إبقاء تركيزك الأساسي على الفلك."
          },
          ...conversation
        ],
        temperature: 0.35,
        max_tokens: 650,
        stream: false
      }),
      signal: AbortSignal.timeout(45_000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Hugging Face inference failed:", upstream.status);
      if (upstream.status === 401 || upstream.status === 403) {
        return res.status(502).json({ error: "رمز الوصول غير صالح أو لا يملك صلاحية الاستدلال. راجع إعداد HF_TOKEN." });
      }
      if (upstream.status === 402 || upstream.status === 429) {
        return res.status(429).json({ error: "رصيد الاستخدام المجاني أو حد الطلبات غير كافٍ حاليًا. تحقق من رصيد Hugging Face وحاول لاحقًا." });
      }
      return res.status(502).json({ error: "نموذج الذكاء الاصطناعي غير متاح الآن. حاول بعد قليل." });
    }

    const reply = data.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return res.status(502).json({ error: "لم يُرجع النموذج إجابة قابلة للعرض. أعد صياغة السؤال." });
    }
    return res.json({ reply });
  } catch (error) {
    console.error("Inference connection error:", error.name);
    return res.status(502).json({ error: "تعذر الاتصال بنموذج الذكاء الاصطناعي. حاول مجددًا." });
  }
});

app.use((req, res) => res.sendFile(path.join(root, "public", "index.html")));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Mirsad listening on " + port));
