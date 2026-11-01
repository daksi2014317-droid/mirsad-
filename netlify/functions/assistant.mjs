const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const recentRequests = new Map();

export default async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "طريقة الطلب غير مدعومة." }), { status: 405, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "تعذّر قراءة السؤال." }), { status: 400, headers });
  }

  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 12) {
    return new Response(JSON.stringify({ error: "صيغة المحادثة غير صحيحة." }), { status: 400, headers });
  }

  const contents = [];
  for (const message of messages) {
    if (!message || !["user", "model", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim() ||
        message.content.length > 2000) {
      return new Response(JSON.stringify({ error: "تحقق من نص السؤال ثم أعد المحاولة." }), { status: 400, headers });
    }
    contents.push({
      role: message.role === "user" ? "user" : "model",
      parts: [{ text: message.content.trim() }]
    });
  }

  if (contents[contents.length - 1].role !== "user") {
    return new Response(JSON.stringify({ error: "أرسل سؤالًا جديدًا للمتابعة." }), { status: 400, headers });
  }

  const ip = request.headers.get("x-nf-client-connection-ip") || "unknown";
  const now = Date.now();
  const recent = (recentRequests.get(ip) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 8) {
    return new Response(JSON.stringify({ error: "أرسلت أسئلة كثيرة خلال دقيقة. انتظر قليلًا ثم حاول مجددًا." }), { status: 429, headers });
  }
  recent.push(now);
  recentRequests.set(ip, recent);

  const apiKey = process.env.GEMINI_API_KEY;
  const baseUrl = process.env.GOOGLE_GEMINI_BASE_URL;
  if (!apiKey || !baseUrl) {
    return new Response(JSON.stringify({
      error: "لم تتفعّل بوابة الذكاء الاصطناعي في هذا النشر بعد. تأكد من أن الموقع منشور على خطة Netlify الائتمانية المجانية وأن AI Features مفعّلة."
    }), { status: 503, headers });
  }

  try {
    const endpoint = baseUrl.replace(/\/$/, "") + "/v1beta/models/gemini-3-flash-preview:generateContent";
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: "أنت نجم، مساعد فلكي تعليمي في موقع مِرصد. أجب بالعربية الواضحة وبأسلوب مناسب للطلاب. اشرح علم الفلك والفضاء بدقة وبطريقة مفهومة ومنظمة. لا تخترع حقائق أو أرقامًا أو مواعيد للأحداث الفلكية. إذا لم تكن متأكدًا أو كانت المعلومة تحتاج بيانات حديثة، فقل ذلك بوضوح. فرّق بين الحقائق العلمية الراسخة والتوقعات والفرضيات. حافظ على سياق المحادثة، واجعل الإجابات مختصرة ما لم يطلب المستخدم تفصيلًا."
          }]
        },
        contents,
        generationConfig: { temperature: 0.35, maxOutputTokens: 800 }
      }),
      signal: AbortSignal.timeout(45_000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Netlify AI Gateway Gemini error:", upstream.status);
      return new Response(JSON.stringify({
        error: upstream.status === 429
          ? "وصل الموقع إلى حد الاستخدام المتاح مؤقتًا. حاول لاحقًا."
          : "تعذّر على خدمة الذكاء الاصطناعي إكمال الإجابة الآن. حاول بعد قليل."
      }), { status: upstream.status === 429 ? 429 : 502, headers });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    if (!reply) {
      return new Response(JSON.stringify({ error: "لم يُرجع النموذج إجابة. حاول صياغة السؤال بطريقة أخرى." }), { status: 502, headers });
    }

    return new Response(JSON.stringify({ reply }), { status: 200, headers });
  } catch (error) {
    console.error("Netlify AI Gateway request failed:", error?.name || "Error");
    return new Response(JSON.stringify({ error: "تعذّر الاتصال بمساعد الذكاء الاصطناعي. حاول مجددًا." }), { status: 502, headers });
  }
};
