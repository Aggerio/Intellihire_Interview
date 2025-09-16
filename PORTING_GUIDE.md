## Video Interview Component - Porting Guide

This guide shows how to integrate the entire real-time video interview experience (OpenAI Realtime API + WebRTC + React UI + server endpoints) into another project. Copy each file/code block into the corresponding locations in your target app. Do not skip any sections.

- Assumptions:
  - Your main project uses Node 18+ and supports ESM or you can adapt `require` equivalents.
  - You will provide your own API key via environment variable `OPENAI_API_KEY`.
  - You will serve the React client in any framework (Vite/Next/CRA). Snippets below are framework-agnostic with notes.

---

### 1) Server: Realtime session and ephemeral token

Create or merge an Express server (or equivalent) with these endpoints:

```js
// server/realtime.js (or merge into your existing server)
import express from "express";
import fs from "fs";
import "dotenv/config";

// If using Vite middleware in your project, wire it similarly. Otherwise, skip the vite section.
// import { createServer as createViteServer } from "vite";

const router = express.Router();
router.use(express.text());

const apiKey = process.env.OPENAI_API_KEY;

// Interview session configuration sent to OpenAI (adjust voice, model, instructions, tools)
const sessionConfig = JSON.stringify({
  session: {
    type: "realtime",
    model: "gpt-realtime",
    instructions:
      "You are an AI interviewer for Hirenest. Speak only in English. Do not switch languages unless explicitly asked to translate. Greet the candidate warmly and explain this is a short, interactive real-time interview. Ask one question at a time and keep responses concise, clear, and professional. Encourage follow‑ups and clarifications if the candidate asks. Focus primarily on these three questions, moving to the next only after acknowledging their answer: 1) What interests you about this company? 2) How does DNS poisoning work? 3) How will you handle conflicts at work? If asked to clarify anything, briefly clarify and then continue. Avoid long monologues. When you determine the interview is finished, call the `complete_interview` tool exactly once with a short optional `summary` of the candidate's performance and an optional `reason` (e.g., finished_all_questions, time_up, user_requested).",
    audio: {
      output: { voice: "marin" },
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

// SDP offer → OpenAI Realtime answer (experimental unified call)
router.post("/session", async (req, res) => {
  const fd = new FormData();
  fd.set("sdp", req.body);
  fd.set("session", sessionConfig);

  const r = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      "OpenAI-Beta": "realtime=v1",
      Authorization: `Bearer ${apiKey}`,
    },
    body: fd,
  });
  const sdp = await r.text();
  res.send(sdp);
});

// Ephemeral token for client-side WebRTC call
router.get("/token", async (req, res) => {
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

export default router;
```

- Mount the router in your server:
```js
// server/index.js (excerpt)
import express from "express";
import realtimeRouter from "./realtime.js";

const app = express();
app.use("/api/realtime", realtimeRouter); // routes: /api/realtime/session, /api/realtime/token

// ... your existing server setup and static file serving
```

- Environment:
```bash
# .env
OPENAI_API_KEY=sk-...
```

Notes:
- If you already have a server, just add the two routes and the `sessionConfig` block.
- If you don’t want to proxy Vite, you can remove all Vite-specific middleware; only the routes are required.

---

### 2) Client: React Interview UI

Create the React component files below (place paths as appropriate in your codebase). Ensure the `/api/realtime/token` path matches your server mount.

```jsx
// components/interview/App.jsx
import { useEffect, useRef, useState } from "react";
import entryVideoAsset from "/assets/2_Entry.mp4";
import idleVideoAsset from "/assets/1_idle_listening.mp4";
import talkingVideoAsset from "/assets/3_Talking.mp4";

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [dataChannel, setDataChannel] = useState(null);
  const peerConnection = useRef(null);
  const audioElement = useRef(null);
  const interviewerVideoRef = useRef(null);
  const cameraVideoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const [interviewerState, setInterviewerState] = useState("idle");
  const talkingTimeoutRef = useRef(null);
  const TALKING_HOLD_MS = 4000;
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const vadRafRef = useRef(null);
  const lastAboveThresholdMsRef = useRef(0);
  const isSpeakingRef = useRef(false);
  const VAD_START_THRESHOLD = 0.04;
  const VAD_STOP_THRESHOLD = 0.02;
  const VAD_REQUIRED_SILENCE_MS = 300;
  const [remainingSeconds, setRemainingSeconds] = useState(600);
  const timerRef = useRef(null);
  const [isInterviewCompleted, setIsInterviewCompleted] = useState(false);
  const [completionSummary, setCompletionSummary] = useState("");
  const [completionReason, setCompletionReason] = useState("");
  const toolCallBuffersRef = useRef({});
  const [pendingCompletion, setPendingCompletion] = useState(null);

  async function startSession() {
    if (peerConnection.current) {
      stopSession();
    }

    const tokenResponse = await fetch("/api/realtime/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.value;

    const pc = new RTCPeerConnection();

    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      audioElement.current.srcObject = stream;
      setupVoiceActivityDetection(stream);
    };

    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc.addTrack(micStream.getTracks()[0]);

    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      cameraStreamRef.current = camStream;
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = camStream;
        await cameraVideoRef.current.play().catch(() => {});
      }
    } catch (err) {
      console.warn("Camera access denied or unavailable", err);
    }

    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime/calls";
    const model = "gpt-realtime";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });

    const sdp = await sdpResponse.text();
    const answer = { type: "answer", sdp };
    await pc.setRemoteDescription(answer);

    peerConnection.current = pc;
  }

  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current?.getSenders().forEach((sender) => {
      sender.track && sender.track.stop();
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    if (audioElement.current) {
      try { audioElement.current.pause(); } catch {}
      audioElement.current.srcObject = null;
    }

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop());
      cameraStreamRef.current = null;
    }

    if (vadRafRef.current) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }

    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch {}
      audioContextRef.current = null;
      analyserRef.current = null;
    }

    setIsSessionActive(false);
    setDataChannel(null);
    peerConnection.current = null;
    setInterviewerState("idle");
    setIsInterviewCompleted(false);
    setCompletionSummary("");
    setCompletionReason("");
    setPendingCompletion(null);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        cameraStreamRef.current = camStream;
        if (cameraVideoRef.current) {
          cameraVideoRef.current.srcObject = camStream;
          await cameraVideoRef.current.play().catch(() => {});
        }
      } catch (err) {
        console.warn("Camera access denied or unavailable", err);
      }
    })();
  }, []);

  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();
      dataChannel.send(JSON.stringify(message));
      if (!message.timestamp) message.timestamp = timestamp;
      setEvents((prev) => [message, ...prev]);
    }
  }

  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message }],
      },
    };
    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
  }

  useEffect(() => {
    if (dataChannel) {
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) event.timestamp = new Date().toLocaleTimeString();
        setEvents((prev) => [event, ...prev]);

        try {
          const type = event.type || "";
          const looksLikeToolEvent = type.includes("function_call") || type.includes("tool_call");
          if (looksLikeToolEvent) {
            const callId = event.call_id || event.id || (event.call && event.call.id);
            const name = event.name || (event.function && event.function.name) || (event.tool && event.tool.name);
            const delta = event.delta || (typeof event.arguments === "string" ? event.arguments : undefined);
            if (callId && name) {
              if (delta) {
                const prev = toolCallBuffersRef.current[callId] || "";
                toolCallBuffersRef.current[callId] = prev + delta;
              }
              const isFinal =
                type.endsWith(".completed") || type.endsWith(".done") || type.endsWith(".finished") ||
                type === "response.function_call.completed" || type === "response.tool_call.completed";
              if (isFinal) {
                let rawArgs = toolCallBuffersRef.current[callId];
                if (!rawArgs && typeof event.arguments === "object") rawArgs = JSON.stringify(event.arguments);
                let parsed = {};
                if (rawArgs) { try { parsed = JSON.parse(rawArgs); } catch {} }

                if (name === "complete_interview") {
                  const summary = parsed.summary || "";
                  const reason = parsed.reason || "";
                  setCompletionSummary(summary);
                  setCompletionReason(reason);
                  setPendingCompletion({ summary, reason });
                  sendClientEvent({ type: "tool.output", call_id: callId, output: JSON.stringify({ acknowledged: true }) });
                }
                delete toolCallBuffersRef.current[callId];
              }
            }
          }
        } catch {}

        const type = event.type || "";
        const isTalkDelta = type === "response.created" || type.startsWith("response.output_") || type === "response.delta";
        const isTalkEnd = type === "response.completed" || type === "response.done" || type === "response.stopped";
        if (isTalkDelta) {
          setInterviewerState((prev) => (prev !== "talking" ? "talking" : prev));
          if (talkingTimeoutRef.current) clearTimeout(talkingTimeoutRef.current);
          talkingTimeoutRef.current = setTimeout(() => { setInterviewerState("idle"); }, TALKING_HOLD_MS);
        }
        if (isTalkEnd) {
          if (talkingTimeoutRef.current) clearTimeout(talkingTimeoutRef.current);
          setInterviewerState("idle");
        }
      });

      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        setRemainingSeconds(600);
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 0));
        }, 1000);

        setInterviewerState("entry");
        setTimeout(() => {
          setInterviewerState("talking");
          const event = {
            type: "response.create",
            response: {
              instructions:
                "Introduce yourself as an AI interviewer for Hirenest. Speak only in English. Explain this is a short, interactive real‑time interview. Ask the first question now: 'What interests you about this company?'. Keep it concise and invite clarifying questions.",
            },
          };
          try { dataChannel.send(JSON.stringify(event)); } catch {}
        }, 400);
      });
    }
  }, [dataChannel]);

  useEffect(() => {
    if (pendingCompletion && interviewerState === "idle") {
      setIsInterviewCompleted(true);
      setPendingCompletion(null);
    }
  }, [pendingCompletion, interviewerState]);

  useEffect(() => {
    const v = interviewerVideoRef.current;
    if (!v) return;
    v.muted = true;
    v.loop = interviewerState !== "entry";
    v.load();
    v.play().catch(() => {});
  }, [interviewerState]);

  function getInterviewerSrc() {
    if (interviewerState === "talking") return talkingVideoAsset;
    if (interviewerState === "idle") return idleVideoAsset;
    return entryVideoAsset;
  }

  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  async function setupVoiceActivityDetection(stream) {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const audioCtx = audioContextRef.current;
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const now = performance.now();
        if (rms >= 0.04) {
          lastAboveThresholdMsRef.current = now;
          if (!isSpeakingRef.current) {
            isSpeakingRef.current = true;
            setInterviewerState("talking");
          }
        } else if (isSpeakingRef.current && rms < 0.02 && now - lastAboveThresholdMsRef.current > 300) {
          isSpeakingRef.current = false;
          setInterviewerState("idle");
        }
        vadRafRef.current = requestAnimationFrame(tick);
      };
      if (vadRafRef.current) cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.warn("VAD setup failed", err);
    }
  }

  return (
    <>
      <header className="absolute top-0 left-0 right-0 h-16 flex items-center px-4">
        <div className="w-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              <div className="text-sm text-slate-500">KP Technologies</div>
              <h1 className="text-base font-semibold">Software Engineer Interview</h1>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <span className="inline-flex items-center gap-1">
                <span className="text-slate-500">Time Remaining:</span>
                <span className="font-semibold">{formatTime(remainingSeconds)}</span>
              </span>
            </div>
            <button onClick={stopSession} className="px-4 py-2 rounded-full text-white bg-red-600 hover:bg-red-700 text-sm">End Interview</button>
          </div>
        </div>
      </header>

      <main className="absolute top-24 left-0 right-0 bottom-16 p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-2 card flex flex-col overflow-hidden">
          <div className="header-gradient text-white px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-sm opacity-90">Meet Tina</div>
              <div className="text-xs opacity-80">Your AI Technical Interviewer</div>
            </div>
            <div className="text-xs flex items-center gap-2 opacity-90">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
              </span>
            </div>
          </div>

          <div className="flex-1 p-4">
            {isInterviewCompleted ? (
              <div className="relative w-full h-full min-h-[320px] rounded-xl overflow-hidden bg-slate-50 flex items-center justify-center">
                <div className="text-center p-6 max-w-lg">
                  <div className="text-3xl mb-2">🎉</div>
                  <h2 className="text-xl font-semibold mb-2">Interview Completed</h2>
                  {completionSummary ? (
                    <p className="text-slate-600 mb-4">{completionSummary}</p>
                  ) : (
                    <p className="text-slate-600 mb-4">Thank you for your time. You may end the session now.</p>
                  )}
                  {completionReason ? (
                    <div className="text-xs text-slate-500 mb-4">Reason: {completionReason}</div>
                  ) : null}
                  <div className="flex items-center justify-center gap-3">
                    <button onClick={stopSession} className="px-4 py-2 rounded-full text-white bg-red-600 hover:bg-red-700 text-sm">End Interview</button>
                    <button onClick={() => { stopSession(); setIsInterviewCompleted(false); setCompletionSummary(""); setCompletionReason(""); setTimeout(() => { startSession(); }, 50); }} className="px-4 py-2 rounded-full text-white bg-blue-600 hover:bg-blue-700 text-sm">Restart</button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="relative w-full h-full min-h-[320px] rounded-xl overflow-hidden bg-slate-100 flex items-center justify-center">
                  <video ref={interviewerVideoRef} src={getInterviewerSrc()} className="w-full h-full object-cover" playsInline autoPlay muted />
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-slate-800 bg-white/80 backdrop-blur px-3 py-1 rounded-full text-xs shadow">Waiting for your response...</div>
                </div>
                <div className="mt-6">
                  <SessionControls startSession={startSession} stopSession={stopSession} sendClientEvent={sendClientEvent} sendTextMessage={(message) => { setInterviewerState("idle"); sendTextMessage(message); }} isSessionActive={isSessionActive} />
                </div>
              </>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-medium">Your Video</div>
            <div className="p-4">
              <div className="relative rounded-lg overflow-hidden bg-slate-100 h-48 md:h-56 lg:h-64 xl:h-72">
                <video ref={cameraVideoRef} className="w-full h-full object-cover" playsInline autoPlay muted />
                <div className="absolute bottom-3 left-3 text-[11px] bg-black/60 text-white px-2 py-1 rounded-full">Camera Active</div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-medium">Tips</div>
            <ul className="p-4 text-sm text-slate-600 list-disc list-inside space-y-2">
              <li>Take your time to think before answering</li>
              <li>Speak clearly and maintain eye contact</li>
              <li>Use examples to support your answers</li>
            </ul>
          </div>
        </aside>
      </main>

      <footer className="absolute left-0 right-0 bottom-0 h-16 px-4">
        <div className="h-full flex items-center justify-between border-t border-slate-200 bg-white/60 backdrop-blur px-2">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            {isSessionActive ? "Recording in progress" : "Ready"}
          </div>
          <div className="flex items-center gap-3">
            <button className="px-4 py-2 rounded-full text-slate-700 bg-slate-100 hover:bg-slate-200 text-sm">Skip</button>
            {isSessionActive ? (
              <button onClick={stopSession} className="px-4 py-2 rounded-full text-white bg-red-600 hover:bg-red-700 text-sm">Stop Session</button>
            ) : (
              <button onClick={startSession} className="px-4 py-2 rounded-full text-white bg-blue-600 hover:bg-blue-700 text-sm">Start Session</button>
            )}
          </div>
        </div>
      </footer>
    </>
  );
}

function SessionControls({ startSession, stopSession, sendClientEvent, sendTextMessage, isSessionActive }) {
  const [isActivating, setIsActivating] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  return (
    <div className="h-full w-full">
      {isSessionActive ? (
        <div className="flex flex-col items-center justify-center w-full h-full gap-4">
          <div className="flex items-center justify-center gap-6">
            <button className="h-12 w-12 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center shadow" onClick={() => sendTextMessage("Could you please repeat the question?")}>↻</button>
            <button className={`relative h-16 w-16 rounded-full flex items-center justify-center text-white shadow-lg bg-gradient-to-br from-violet-600 to-violet-500 ${isRequesting ? "opacity-70" : "hover:brightness-110"}`} onClick={async () => { if (isRequesting) return; setIsRequesting(true); try { sendClientEvent({ type: "response.create" }); } finally { setIsRequesting(false); } }}>🎤</button>
            <button className="h-12 w-12 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center shadow">🔈</button>
          </div>
          <div className="text-xs text-slate-500">Click the microphone to start your response</div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center w-full h-full gap-3">
          <div className={`relative h-16 w-16 rounded-full flex items-center justify-center text-white shadow-lg cursor-pointer bg-gradient-to-br from-violet-600 to-violet-500 ${isActivating ? "opacity-70" : "hover:brightness-110"}`} onClick={async () => { if (isActivating) return; setIsActivating(true); try { await startSession(); } finally { setIsActivating(false); } }}>🎤</div>
          <div className="text-xs text-slate-500">Click the microphone to start your response</div>
        </div>
      )}
    </div>
  );
}
```

- Place your videos under a public path, e.g. `/assets/1_idle_listening.mp4`, `/assets/2_Entry.mp4`, `/assets/3_Talking.mp4`.
- If using a bundler, import them or serve from `public/assets`.

---

### 3) Styles (Tailwind + base)

You can reuse the minimal CSS utility setup:

```css
/* styles/base.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --color-base: #efefef;
  --color-highlight: #ff80ff;
}

html, body {
  height: 100%;
  width: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto,
    Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
  font-size: 14px;
  background-color: #f8fafc;
  color: #0f172a;
}

:root {
  --brand: #5b21b6;
  --brand-600: #7c3aed;
  --brand-500: #8b5cf6;
  --surface: #ffffff;
  --muted: #64748b;
}

.card { background: var(--surface); border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 1px 2px rgba(2, 6, 23, 0.04); }
.header-gradient { background: linear-gradient(90deg, var(--brand-600), var(--brand-500)); }
```

Tailwind config:
```js
// tailwind.config.js
export default {
  content: ["./index.html", "./**/*.{jsx,tsx,js,ts}"],
  theme: { extend: {} },
  plugins: [],
};
```

PostCSS config:
```js
// postcss.config.cjs
module.exports = {
  plugins: {
    "tailwindcss/nesting": "postcss-nesting",
    tailwindcss: {},
    "postcss-preset-env": { stage: 1, features: { "nesting-rules": false } },
  },
};
```

---

### 4) HTML Shell (if using Vite or static HTML)

```html
<!-- index.html excerpt -->
<link rel="stylesheet" href="/styles/base.css" />
<div id="root"></div>
<script type="module" src="/entry-client.jsx"></script>
```

Client/SSR entry (optional):
```jsx
// entry-client.jsx
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import App from "./components/interview/App";
import "./styles/base.css";
ReactDOM.hydrateRoot(document.getElementById("root"), (
  <StrictMode><App /></StrictMode>
));
```

```jsx
// entry-server.jsx
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import App from "./components/interview/App";
export function render() {
  const html = renderToString(<StrictMode><App /></StrictMode>);
  return { html };
}
```

---

### 5) Dependencies

Install the required packages in your main project:
```bash
npm i express dotenv react react-dom
npm i -D @vitejs/plugin-react vite tailwindcss postcss postcss-nesting postcss-preset-env
```

If you already have a framework (Next.js, etc.), only add what you’re missing.

---

### 6) Asset placement

Copy these assets to a public/served path and update imports/paths accordingly:
- `/assets/1_idle_listening.mp4`
- `/assets/2_Entry.mp4`
- `/assets/3_Talking.mp4`

---

### 7) Security and prod notes

- Never expose your primary `OPENAI_API_KEY` to the browser; only return ephemeral tokens from the server route.
- Consider rate limiting `/api/realtime/token` and auth‑gate it to authenticated candidates.
- In production, host the assets via CDN or static server and set appropriate cache headers.

---

### 8) Quick embedding snippet

Render the interview anywhere in your app:
```jsx
import App from "./components/interview/App";
export default function CandidateInterviewPage() {
  return <App />;
}
```

---

### 9) Feature parity checklist

- Realtime WebRTC with mic capture and remote audio playback
- Camera preview for candidate (not sent to model)
- Data channel events, including `response.create` and text messages
- Tool/function call handling for `complete_interview` with streamed args
- Entry/idle/talking video state logic with simple VAD fallback
- Countdown timer and completion screen with reason/summary
- Tailwind-based UI styles and utility classes

If you need help adapting this to Next.js routes or a different server, drop your structure and I’ll tailor the exact file paths and imports.

