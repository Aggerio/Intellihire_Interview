## Interview Completion System

This document explains how interview completion is triggered by the model, streamed to the client, acknowledged, and then surfaced in the UI.

---

### 1) Server: Tool definition in the session config

The server declares a function tool named `complete_interview` inside `sessionConfig`. This is part of the Realtime session configuration sent to OpenAI. The model calls this tool exactly once when it decides the interview has ended.

```js
// server.js (excerpt)
const sessionConfig = JSON.stringify({
  session: {
    type: "realtime",
    model: "gpt-realtime",
    instructions: "...",
    audio: { output: { voice: "marin" } },
    tools: [
      {
        type: "function",
        name: "complete_interview",
        description: "Signal that the interview has concluded. Provide a brief optional summary and/or reason.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Short wrap-up (1-3 sentences)." },
            reason: {
              type: "string",
              enum: ["finished_all_questions", "time_up", "user_requested", "other"],
              description: "Why the interview ended.",
            },
          },
        },
      },
    ],
  },
});
```

- The model may stream function/tool call arguments over the data channel as deltas; the client must buffer until completion.

---

### 2) Client: Receiving and buffering streamed tool arguments

On the client, messages arrive on the WebRTC data channel. Tool/function calls can be streamed; we buffer partial `arguments` by `call_id` until a completion event.

```js
// client/components/App.jsx (excerpt)
const toolCallBuffersRef = useRef({});

dataChannel.addEventListener("message", (e) => {
  const event = JSON.parse(e.data);
  // ... append event to UI log, add timestamp, etc.

  const type = event.type || "";
  const looksLikeToolEvent = type.includes("function_call") || type.includes("tool_call");
  if (looksLikeToolEvent) {
    const callId = event.call_id || event.id || (event.call && event.call.id);
    const name = event.name || (event.function && event.function.name) || (event.tool && event.tool.name);
    const delta = event.delta || (typeof event.arguments === "string" ? event.arguments : undefined);

    if (callId && name) {
      if (delta) {
        const prev = toolCallBuffersRef.current[callId] || "";
        toolCallBuffersRef.current[callId] = prev + delta; // accumulate stream
      }

      const isFinal =
        type.endsWith(".completed") || type.endsWith(".done") || type.endsWith(".finished") ||
        type === "response.function_call.completed" || type === "response.tool_call.completed";

      if (isFinal) {
        let rawArgs = toolCallBuffersRef.current[callId];
        if (!rawArgs && typeof event.arguments === "object") {
          rawArgs = JSON.stringify(event.arguments);
        }

        let parsed = {};
        if (rawArgs) {
          try { parsed = JSON.parse(rawArgs); } catch {}
        }

        if (name === "complete_interview") {
          const summary = parsed.summary || "";
          const reason = parsed.reason || "";
          setCompletionSummary(summary);
          setCompletionReason(reason);
          setPendingCompletion({ summary, reason });

          // Acknowledge tool execution back to the model
          sendClientEvent({
            type: "tool.output",
            call_id: callId,
            output: JSON.stringify({ acknowledged: true }),
          });
        }

        // cleanup buffer
        delete toolCallBuffersRef.current[callId];
      }
    }
  }

  // ... interviewer talk state updates, etc.
});
```

Key points:
- `toolCallBuffersRef` stores partial `arguments` payloads indexed by `call_id`.
- When the final completion event arrives, we parse the accumulated JSON payload.
- We store `summary` and `reason` in state and mark `pendingCompletion` so the UI can react at the right time.

---

### 3) Deferring the completion screen until the interviewer is idle

To avoid interrupting the last spoken words or animations, the UI waits for the interviewer to return to the `idle` state before showing the completion screen.

```js
// client/components/App.jsx (excerpt)
const [interviewerState, setInterviewerState] = useState("idle");
const [pendingCompletion, setPendingCompletion] = useState(null);
const [isInterviewCompleted, setIsInterviewCompleted] = useState(false);

useEffect(() => {
  if (pendingCompletion && interviewerState === "idle") {
    setIsInterviewCompleted(true);
    setPendingCompletion(null);
  }
}, [pendingCompletion, interviewerState]);
```

- `interviewerState` toggles among `entry | idle | talking`.
- A simple VAD and response delta timing maintain `talking` vs `idle`.

---

### 4) Completion UI and controls

Once `isInterviewCompleted` is true, the main panel renders a completion screen showing the optional `summary` and `reason`. It provides actions to end or restart the session.

```jsx
// client/components/App.jsx (excerpt)
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
  // ... normal interview UI
)}
```

---

### 5) Event that kicks off the completion

The completion is initiated entirely by the model via a tool/function call to `complete_interview`. Your instructions in `sessionConfig` guide when the model should call it and what optional fields to include.

- Example of parsed payload fields:
  - `summary`: short wrap-up for the candidate or internal note.
  - `reason`: one of `finished_all_questions | time_up | user_requested | other`.

You can enrich the UI or downstream logic (e.g., persist results, analytics) using these fields.

---

### 6) Acknowledging tool execution

After handling `complete_interview`, the client sends a `tool.output` event with the same `call_id`. This acknowledges to the model that the tool was received and processed.

```js
sendClientEvent({
  type: "tool.output",
  call_id: callId,
  output: JSON.stringify({ acknowledged: true }),
});
```

- This mirrors tool-calling workflows: model calls tool → client performs side effects → client replies with tool output → model can finalize.

---

### 7) Extending completion behavior

You can customize completion behavior by:
- Adding fields to the tool `parameters` (e.g., score, category, tags) and reading them in the client.
- Emitting an API call to persist results when `isInterviewCompleted` becomes true.
- Navigating to a results page instead of showing the in-place screen.
- Locking UI controls post-completion, if desired.

All core wiring is already in place; only extend the schema and the handling block.
