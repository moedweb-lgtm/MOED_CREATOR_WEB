import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const MOED_KB_URL = process.env.MOED_KB_URL;

const sessions = new Map();

const FALLBACK_KB = {
  rules: [
    "Responde en espanol claro y directo.",
    "No inventes informacion.",
    "Adapta la respuesta al rol del usuario."
  ],
  roles: {
    visitante: {
      description: "Visitante de MOED.",
      content: ["Puede pedir informacion general y ayuda basica."]
    },
    trabajador: {
      description: "Trabajador de MOED.",
      content: ["Puede pedir ayuda sobre tareas, soporte y organizacion interna."]
    },
    moderador: {
      description: "Moderador de MOED.",
      content: ["Puede gestionar soporte, revisar problemas y coordinar trabajadores."]
    }
  }
};

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function checkAccess(role, code) {
  if (role === "visitante") {
    return !process.env.VISITOR_ACCESS_CODE || code === process.env.VISITOR_ACCESS_CODE;
  }
  if (role === "trabajador") return code === process.env.WORKER_ACCESS_CODE;
  if (role === "moderador") return code === process.env.MODERATOR_ACCESS_CODE;
  return false;
}

async function loadKnowledge() {
  if (!MOED_KB_URL) return FALLBACK_KB;

  try {
    const response = await fetch(MOED_KB_URL);
    if (!response.ok) return FALLBACK_KB;

    const text = await response.text();
    if (text.trim().startsWith("<")) return FALLBACK_KB;

    return JSON.parse(text);
  } catch {
    return FALLBACK_KB;
  }
}

function getRoleKnowledge(kb, role) {
  const selected = kb.roles?.[role] || kb.roles?.visitante || {};
  const rules = Array.isArray(kb.rules) ? kb.rules : [];
  const content = Array.isArray(selected.content) ? selected.content : [];

  return [selected.description || "", ...content, ...rules]
    .filter(Boolean)
    .join("\n");
}

app.post("/api/login", (req, res) => {
  const { name, email, uid, role, code } = req.body || {};

  if (!name || !email || !uid || !role) {
    return res.status(400).json({ error: "Faltan datos de usuario." });
  }

  if (!checkAccess(role, code || "")) {
    return res.status(401).json({ error: "Codigo incorrecto." });
  }

  const token = crypto.randomUUID();

  sessions.set(token, {
    name: String(name).slice(0, 60),
    email: String(email).slice(0, 120),
    uid: String(uid),
    role,
    createdAt: Date.now()
  });

  res.json({ token, name, email, role });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { token, message } = req.body || {};
    const session = sessions.get(token);

    if (!session) {
      return res.status(401).json({ error: "Sesion no valida." });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Falta GEMINI_API_KEY en Render." });
    }

    const kb = await loadKnowledge();
    const roleKnowledge = getRoleKnowledge(kb, session.role);

    const prompt =
      `Eres MOED Creator, una IA tipo ChatGPT para MOED.\n` +
      `Usuario: ${session.name}\nEmail: ${session.email}\nRol: ${session.role}\n\n` +
      `Responde en espanol, claro y util.\n` +
      `No inventes informacion. Si falta contexto, pregunta.\n\n` +
      `Informacion MOED para este rol:\n${roleKnowledge}\n\n` +
      `Mensaje:\n${String(message || "")}`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 900 }
        })
      }
    );

    if (!geminiResponse.ok) throw new Error(await geminiResponse.text());

    const data = await geminiResponse.json();
    const reply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No pude generar respuesta.";

    res.json({ reply });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`MOED Creator activo en puerto ${PORT}`);
});
