import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";

const app = express();
app.use(express.text());
const port = process.env.PORT || 3001;
const apiKey = process.env.OPENAI_API_KEY;

// Configure Vite middleware for React client
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: "custom",
});
app.use(vite.middlewares);

const sessionConfig = JSON.stringify({
  session: {
    type: "realtime",
    model: "gpt-realtime",
    instructions:
      "You are an AI interviewer for Intellihire. Speak only in English. Do not switch languages unless explicitly asked to translate. Greet the candidate warmly and explain this is a short, interactive real-time interview. Ask one question at a time and keep responses concise, clear, and professional. Encourage follow‑ups and clarifications if the candidate asks. Focus primarily on these three questions, moving to the next only after acknowledging their answer: 1) What interests you about this company? 2) How does DNS poisoning work? 3) How will you handle conflicts at work? If asked to clarify anything, briefly clarify and then continue. Avoid long monologues. When you determine the interview is finished, call the `complete_interview` tool exactly once with a short optional `summary` of the candidate's performance and an optional `reason` (e.g., finished_all_questions, time_up, user_requested).",
    audio: {
      output: {
        voice: "marin",
      },
    },
    tools: [
      {
        type: "function",
        name: "complete_interview",
        description:
          "Signal that the interview has concluded. Provide a brief optional summary and/or reason.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description:
                "Short wrap-up message for the candidate or internal summary (1-3 sentences).",
            },
            reason: {
              type: "string",
              enum: [
                "finished_all_questions",
                "time_up",
                "user_requested",
                "other",
              ],
              description: "Why the interview ended.",
            },
          },
        },
      },
    ],
  },
});

// All-in-one SDP request (experimental)
app.post("/session", async (req, res) => {
  const fd = new FormData();
  console.log(req.body);
  fd.set("sdp", req.body);
  fd.set("session", sessionConfig);

  const r = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      "OpenAI-Beta": "realtime=v1",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: fd,
  });
  const sdp = await r.text();
  console.log(sdp);

  // Send back the SDP we received from the OpenAI REST API
  res.send(sdp);
});

// API route for ephemeral token generation
app.get("/token", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: sessionConfig,
      },
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// Render the React client
app.use("*", async (req, res, next) => {
  const url = req.originalUrl;

  try {
    const template = await vite.transformIndexHtml(
      url,
      fs.readFileSync("./client/index.html", "utf-8"),
    );
    const { render } = await vite.ssrLoadModule("./client/entry-server.jsx");
    const appHtml = await render(url);
    const html = template.replace(`<!--ssr-outlet-->`, appHtml?.html);
    res.status(200).set({ "Content-Type": "text/html" }).end(html);
  } catch (e) {
    vite.ssrFixStacktrace(e);
    next(e);
  }
});

app.listen(port, () => {
  console.log(`Express server running on *:${port}`);
});
