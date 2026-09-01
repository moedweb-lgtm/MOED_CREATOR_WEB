import express from "express";
import crypto from "crypto";
import admin from "firebase-admin";

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const MODERATOR_ACCESS_CODE = process.env.MODERATOR_ACCESS_CODE;
const MOED_KB_URL = process.env.MOED_KB_URL;

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  throw new Error("Falta FIREBASE_SERVICE_ACCOUNT_JSON en Render.");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
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
    moderador: {
      description: "Moderador de MOED.",
      content: [
        "Puede gestionar soporte, crear codigos de visitante y revisar informacion importante."
      ]
    }
  }
};

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

async function verifyFirebaseUser(idToken) {
  if (!idToken) throw new Error("Falta sesion de Firebase.");
  return admin.auth().verifyIdToken(idToken);
}

async function getRoleFromCode(code) {
  if (!code) return null;

  if (MODERATOR_ACCESS_CODE && code === MODERATOR_ACCESS_CODE) {
    return "moderador";
  }

  const doc = await db.collection("accessCodes").doc(code).get();
  if (!doc.exists) return null;

  const data = doc.data();

  if (data.active === true && data.role === "visitante") {
    return "visitante";
  }

  return null;
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

app.post("/api/resolve-code", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    const role = await getRoleFromCode(code);

    if (!role) {
      return res.status(401).json({ error: "Codigo incorrecto." });
    }

    res.json({ role });
  } catch (error) {
    res.status(500).json({ error: error.message || "Error interno." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { idToken, code } = req.body || {};
    const user = await verifyFirebaseUser(idToken);
    const role = await getRoleFromCode(String(code || "").trim());

    if (!role) {
      return res.status(401).json({ error: "Codigo incorrecto." });
    }

    const token = crypto.randomUUID();

    sessions.set(token, {
      uid: user.uid,
      name: user.name || user.email || "Usuario",
      email: user.email || "",
      role,
      createdAt: Date.now()
    });

    await db.collection("users").doc(user.uid).set(
      {
        name: user.name || user.email || "Usuario",
        email: user.email || "",
        lastRole: role,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    res.json({
      token,
      role,
      name: user.name || user.email || "Usuario",
      email: user.email || ""
    });
  } catch (error) {
    res.status(401).json({ error: error.message || "No se pudo iniciar sesion." });
  }
});

app.post("/api/codes", async (req, res) => {
  try {
    const { token, label } = req.body || {};
    const session = sessions.get(token);

    if (!session || session.role !== "moderador") {
      return res.status(403).json({ error: "Solo moderadores pueden crear codigos." });
    }

    const code = "MOED-" + crypto.randomBytes(5).toString("hex").toUpperCase();

    await db.collection("accessCodes").doc(code).set({
      code,
      label: label || "Codigo visitante",
      role: "visitante",
      active: true,
      createdBy: session.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ code });
  } catch (error) {
    res.status(500).json({ error: error.message || "No se pudo crear el codigo." });
  }
});

app.post("/api/chats", async (req, res) => {
  try {
    const { token } = req.body || {};
    const session = sessions.get(token);

    if (!session) {
      return res.status(401).json({ error: "Sesion no valida." });
    }

    const snap = await db
      .collection("users")
      .doc(session.uid)
      .collection("chats")
      .orderBy("updatedAt", "desc")
      .limit(30)
      .get();

    const chats = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ chats });
  } catch (error) {
    res.status(500).json({ error: error.message || "No se pudieron cargar chats." });
  }
});

app.post("/api/chat-messages", async (req, res) => {
  try {
    const { token, chatId } = req.body || {};
    const session = sessions.get(token);

    if (!session || !chatId) {
      return res.status(401).json({ error: "Sesion no valida." });
    }

    const snap = await db
      .collection("users")
      .doc(session.uid)
      .collection("chats")
      .doc(chatId)
      .collection("messages")
      .orderBy("createdAt", "asc")
      .get();

    const messages = snap.docs.map((doc) => doc.data());

    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message || "No se pudo cargar el chat." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { token, chatId, message } = req.body || {};
    const session = sessions.get(token);

    if (!session) {
      return res.status(401).json({ error: "Sesion no valida." });
    }

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Falta GEMINI_API_KEY en Render." });
    }

    const text = String(message || "").trim();
    if (!text) {
      return res.status(400).json({ error: "Mensaje vacio." });
    }

    const finalChatId = chatId || crypto.randomUUID();
    const kb = await loadKnowledge();
    const roleKnowledge = getRoleKnowledge(kb, session.role);

    const chatRef = db
      .collection("users")
      .doc(session.uid)
      .collection("chats")
      .doc(finalChatId);

    await chatRef.set(
      {
        title: text.slice(0, 60),
        role: session.role,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    await chatRef.collection("messages").add({
      role: "user",
      text,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const prompt =
      `Eres MOED Creator, una IA tipo ChatGPT para MOED.\n` +
      `Usuario: ${session.name}\n` +
      `Rol: ${session.role}\n\n` +
      `Responde en espanol claro, util y directo.\n` +
      `No inventes informacion. Si falta contexto, pregunta.\n\n` +
      `Informacion de MOED para este rol:\n${roleKnowledge}\n\n` +
      `Mensaje del usuario:\n${text}`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 900
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

    await chatRef.collection("messages").add({
      role: "assistant",
      text: reply,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ reply, chatId: finalChatId });
  } catch (error) {
    console.error("ERROR MOED CREATOR:", error);
    res.status(500).json({ error: error.message || "Error interno." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => {
  console.log(`MOED Creator activo en puerto ${PORT}`);
});
