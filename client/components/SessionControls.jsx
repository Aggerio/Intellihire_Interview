import { useState } from "react";
import { Mic, RotateCcw, Volume2 } from "react-feather";

function SessionStopped({ startSession }) {
  const [isActivating, setIsActivating] = useState(false);

  async function handleStartSession() {
    if (isActivating) return;
    setIsActivating(true);
    try {
      await startSession();
    } finally {
      setIsActivating(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center w-full h-full gap-3">
      <div className={`relative h-16 w-16 rounded-full flex items-center justify-center text-white shadow-lg cursor-pointer bg-gradient-to-br from-violet-600 to-violet-500 ${isActivating ? "opacity-70" : "hover:brightness-110"}`} onClick={handleStartSession}>
        <Mic size={24} />
      </div>
      <div className="text-xs text-slate-500">Click the microphone to start your response</div>
    </div>
  );
}

function SessionActive({ sendTextMessage, sendClientEvent }) {
  const [isRequesting, setIsRequesting] = useState(false);

  async function handleMicClick() {
    if (isRequesting) return;
    setIsRequesting(true);
    try {
      // Nudge the model to continue/respond if needed
      sendClientEvent({ type: "response.create" });
    } finally {
      setIsRequesting(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center w-full h-full gap-4">
      <div className="flex items-center justify-center gap-6">
        <button
          className="h-12 w-12 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center shadow"
          onClick={() => sendTextMessage("Could you please repeat the question?")}
          title="Replay prompt"
        >
          <RotateCcw size={18} />
        </button>

        <button
          className={`relative h-16 w-16 rounded-full flex items-center justify-center text-white shadow-lg bg-gradient-to-br from-violet-600 to-violet-500 ${isRequesting ? "opacity-70" : "hover:brightness-110"}`}
          onClick={handleMicClick}
          title="Respond"
        >
          <Mic size={24} />
        </button>

        <button
          className="h-12 w-12 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center shadow"
          onClick={() => {}}
          title="Speaker"
        >
          <Volume2 size={18} />
        </button>
      </div>
      <div className="text-xs text-slate-500">Click the microphone to start your response</div>
    </div>
  );
}

export default function SessionControls({
  startSession,
  stopSession,
  sendClientEvent,
  sendTextMessage,
  serverEvents,
  isSessionActive,
}) {
  return (
    <div className="h-full w-full">
      {isSessionActive ? (
        <SessionActive
          sendClientEvent={sendClientEvent}
          sendTextMessage={sendTextMessage}
          serverEvents={serverEvents}
        />
      ) : (
        <SessionStopped startSession={startSession} />
      )}
    </div>
  );
}
