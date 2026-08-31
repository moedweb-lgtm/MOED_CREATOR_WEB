import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MOED_KB_URL =
  process.env.MOED_KB_URL ||
  "https://cloud.vento.build/networks/mamarcosane/moed-kb.json";

const sessions = new Map();

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function checkAccess(role, code) {
  if (role === "visitante") {
    return !process.env.VISITOR_ACCESS_CODE || code === process.env.VISITOR_ACCESS_CODE;
  }

  if (role === "trabajador") {
    return code === process.env.WORKER_ACCESS_CODE;
  }

  if (role === "moderador") {
    return code === process.env.MODERATOR_ACCESS_CODE;
  }

  return false;
}

async function loadKnowledge() {
  const response = await fetch(MOED_KB_URL);

  if (!response.ok) {
    throw new Error("No pude cargar la base de conocimiento de MOED.");
  }

  return response.json();
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
  const { name, role, code } = req.body || {};

  if (!name || !role) {
    return res.status(400).json({ error: "Falta nombre o rol." });
  }

  if (!checkAccess(role, code || "")) {
    return res.status(401).json({ error: "Codigo incorrecto." });
  }

  const token = crypto.randomUUID();

  sessions.set(token, {
    name: String(name).slice(0, 50),
    role,
    createdAt: Date.now()
  });

  res.json({ token, role, name });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { token, message } = req.body || {};
    const session = sessions.get(token);

    if (!session) {
      return res.status(401).json({
        error: "Sesion no valida. Inicia sesion otra vez."
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Falta GEMINI_API_KEY en Render."
      });
    }

    const kb = await loadKnowledge();
    const roleKnowledge = getRoleKnowledge(kb, session.role);

    const prompt =
      `Eres MOED Creator, una IA de soporte para MOED.\n` +
      `Usuario: ${session.name}\n` +
      `Rol: ${session.role}\n\n` +
      `Responde en espanol claro y directo.\n` +
      `No inventes informacion. Si no sabes algo, pide mas contexto.\n` +
      `Adapta la respuesta al rol del usuario.\n\n` +
      `Informacion de MOED para este rol:\n${roleKnowledge}\n\n` +
      `Pregunta del usuario:\n${String(message || "")}`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 800
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      throw new Error(await geminiResponse.text());
    }

    const data = await geminiResponse.json();
    const reply =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No pude generar respuesta.";

    res.json({ reply, role: session.role });
  } catch (error) {
    console.error("ERROR MOED CREATOR:", error);
    res.status(500).json({
      error: error.message || "Error interno."
    });
  }
});

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`MOED Creator web activo en puerto ${PORT}`);
});
