import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import SessionControls from "./SessionControls";
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
  const [interviewerState, setInterviewerState] = useState("idle"); // entry | idle | talking
  const talkingTimeoutRef = useRef(null);
  const TALKING_HOLD_MS = 4000; // keep talking state unless no deltas for this duration
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const vadRafRef = useRef(null);
  const lastAboveThresholdMsRef = useRef(0);
  const isSpeakingRef = useRef(false);
  const VAD_START_THRESHOLD = 0.04; // RMS to start talking
  const VAD_STOP_THRESHOLD = 0.02; // RMS to consider silence
  const VAD_REQUIRED_SILENCE_MS = 300; // how long silence to switch to idle
  const [remainingSeconds, setRemainingSeconds] = useState(600); // 10 minutes
  const timerRef = useRef(null);
  const [isInterviewCompleted, setIsInterviewCompleted] = useState(false);
  const [completionSummary, setCompletionSummary] = useState("");
  const [completionReason, setCompletionReason] = useState("");
  const toolCallBuffersRef = useRef({});
  const [pendingCompletion, setPendingCompletion] = useState(null);

  async function startSession() {
    // Prevent overlapping sessions
    if (peerConnection.current) {
      stopSession();
    }
    // Get a session token for OpenAI Realtime API
    const tokenResponse = await fetch("/token");
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.value;

    // Create a peer connection
    const pc = new RTCPeerConnection();

    // Set up to play remote audio from the model
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      audioElement.current.srcObject = stream;
      setupVoiceActivityDetection(stream);
    };

    // Add local audio track for microphone input in the browser
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    pc.addTrack(micStream.getTracks()[0]);

    // Ask for camera permission and show local preview on the right (not shared with model)
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      cameraStreamRef.current = camStream;
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = camStream;
        await cameraVideoRef.current.play().catch(() => {});
      }
    } catch (err) {
      console.warn("Camera access denied or unavailable", err);
    }

    // Set up data channel for sending and receiving events
    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    // Start the session using the Session Description Protocol (SDP)
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

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    if (audioElement.current) {
      try {
        audioElement.current.pause();
      } catch {}
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
      try {
        audioContextRef.current.close();
      } catch {}
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

  // Ask for camera permission on load to show preview immediately
  useEffect(() => {
    (async () => {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
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

  // Send a message to the model
  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();

      // send event before setting timestamp since the backend peer doesn't expect this field
      dataChannel.send(JSON.stringify(message));

      // if guard just in case the timestamp exists by miracle
      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error(
        "Failed to send message - no data channel available",
        message,
      );
    }
  }

  // Send a text message to the model
  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
  }

  // Attach event listeners to the data channel when a new one is created
  useEffect(() => {
    if (dataChannel) {
      // Append new server events to the list
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }

        setEvents((prev) => [event, ...prev]);

        // Handle tool/function call events (streamed arguments + completion)
        try {
          const type = event.type || "";
          const looksLikeToolEvent =
            type.includes("function_call") || type.includes("tool_call");
          if (looksLikeToolEvent) {
            const callId = event.call_id || event.id || (event.call && event.call.id);
            const name = event.name || (event.function && event.function.name) || (event.tool && event.tool.name);
            const delta =
              event.delta ||
              (typeof event.arguments === "string" ? event.arguments : undefined);
            if (callId && name) {
              if (delta) {
                const prev = toolCallBuffersRef.current[callId] || "";
                toolCallBuffersRef.current[callId] = prev + delta;
              }
              const isFinal =
                type.endsWith(".completed") ||
                type.endsWith(".done") ||
                type.endsWith(".finished") ||
                type === "response.function_call.completed" ||
                type === "response.tool_call.completed";
              if (isFinal) {
                let rawArgs = toolCallBuffersRef.current[callId];
                if (!rawArgs && typeof event.arguments === "object") {
                  // sometimes arguments may arrive fully as object
                  rawArgs = JSON.stringify(event.arguments);
                }
                let parsed = {};
                if (rawArgs) {
                  try {
                    parsed = JSON.parse(rawArgs);
                  } catch {}
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
        } catch {}

        // Update interviewer video state from response events
        const type = event.type || "";
        const isTalkDelta =
          type === "response.created" ||
          type.startsWith("response.output_") ||
          type === "response.delta";
        const isTalkEnd =
          type === "response.completed" ||
          type === "response.done" ||
          type === "response.stopped";

        if (isTalkDelta) {
          setInterviewerState((prev) => (prev !== "talking" ? "talking" : prev));
          if (talkingTimeoutRef.current) clearTimeout(talkingTimeoutRef.current);
          // Fallback: if deltas stop unexpectedly, return to idle shortly
          talkingTimeoutRef.current = setTimeout(() => {
            setInterviewerState("idle");
          }, TALKING_HOLD_MS);
        }

        if (isTalkEnd) {
          if (talkingTimeoutRef.current) clearTimeout(talkingTimeoutRef.current);
          setInterviewerState("idle");
        }
      });

      // Set session active when the data channel is opened
      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
        // reset and start countdown on session start
        setRemainingSeconds(600);
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setRemainingSeconds((prev) => (prev > 0 ? prev - 1 : 0));
        }, 1000);

        // Play entry animation video and start the interview greeting
        setInterviewerState("entry");
        setTimeout(() => {
          setInterviewerState("talking");
          // Kick off the interviewer introduction and first question
          const event = {
            type: "response.create",
            response: {
              instructions:
                "Introduce yourself as an AI interviewer for Hirenest. Speak only in English. Explain this is a short, interactive real‑time interview. Ask the first question now: 'What interests you about this company?'. Keep it concise and invite clarifying questions.",
            },
          };
          try {
            dataChannel.send(JSON.stringify(event));
          } catch {}
        }, 400);
      });
    }
  }, [dataChannel]);

  // Defer showing the completion screen until the interviewer is idle
  useEffect(() => {
    if (pendingCompletion && interviewerState === "idle") {
      setIsInterviewCompleted(true);
      setPendingCompletion(null);
    }
  }, [pendingCompletion, interviewerState]);

  // Ensure the interviewer video plays when the state or source changes
  useEffect(() => {
    const v = interviewerVideoRef.current;
    if (!v) return;
    v.muted = true; // allow autoplay
    v.loop = interviewerState !== "entry";
    // Force reload so source switches consistently
    v.load();
    v.play().catch(() => {});
  }, [interviewerState]);

  function getInterviewerSrc() {
    if (interviewerState === "talking") return talkingVideoAsset;
    if (interviewerState === "idle") return idleVideoAsset;
    return entryVideoAsset;
  }

  function formatTime(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  // Basic voice activity detection on the model's remote audio stream
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

        // Compute RMS in range [0,1]
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);

        const now = performance.now();
        if (rms >= VAD_START_THRESHOLD) {
          lastAboveThresholdMsRef.current = now;
          if (!isSpeakingRef.current) {
            isSpeakingRef.current = true;
            setInterviewerState("talking");
          }
        } else if (
          isSpeakingRef.current &&
          rms < VAD_STOP_THRESHOLD &&
          now - lastAboveThresholdMsRef.current > VAD_REQUIRED_SILENCE_MS
        ) {
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
      {/* Top Header */}
      <header className="absolute top-0 left-0 right-0 h-16 flex items-center px-4">
        <div className="w-full flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img style={{ width: "24px" }} src={logo} />
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
            <button
              onClick={stopSession}
              className="px-4 py-2 rounded-full text-white bg-red-600 hover:bg-red-700 text-sm"
            >
              End Interview
            </button>
          </div>
        </div>
      </header>

      {/* Progress */}
      <div className="absolute top-16 left-0 right-0 px-4">
        <div className="flex items-center justify-between text-sm text-slate-600 py-2">
          {/* <div className="w-48 h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className="h-full bg-violet-500" style={{ width: "45%" }} />
          </div> */}
        </div>
      </div>

      {/* Main */}
      <main className="absolute top-24 left-0 right-0 bottom-16 p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left card */}
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
                    <button
                      onClick={stopSession}
                      className="px-4 py-2 rounded-full text-white bg-red-600 hover:bg-red-700 text-sm"
                    >
                      End Interview
                    </button>
                    <button
                      onClick={() => {
                        // cleanly end and start a new session
                        stopSession();
                        setIsInterviewCompleted(false);
                        setCompletionSummary("");
                        setCompletionReason("");
                        setTimeout(() => {
                          startSession();
                        }, 50);
                      }}
                      className="px-4 py-2 rounded-full text-white bg-blue-600 hover:bg-blue-700 text-sm"
                    >
                      Restart
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="relative w-full h-full min-h-[320px] rounded-xl overflow-hidden bg-slate-100 flex items-center justify-center">
                  <video
                    ref={interviewerVideoRef}
                    src={getInterviewerSrc()}
                    className="w-full h-full object-cover"
                    playsInline
                    autoPlay
                    muted
                  />
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-slate-800 bg-white/80 backdrop-blur px-3 py-1 rounded-full text-xs shadow">
                    Waiting for your response...
                  </div>
                </div>
                <div className="mt-6">
                  <SessionControls
                    startSession={startSession}
                    stopSession={stopSession}
                    sendClientEvent={sendClientEvent}
                    sendTextMessage={(message) => {
                      setInterviewerState("idle");
                      sendTextMessage(message);
                    }}
                    events={events}
                    isSessionActive={isSessionActive}
                  />
                </div>
              </>
            )}
          </div>
        </section>

        {/* Right sidebar */}
        <aside className="flex flex-col gap-4">
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 text-sm font-medium">Your Video</div>
            <div className="p-4">
              <div className="relative rounded-lg overflow-hidden bg-slate-100 h-48 md:h-56 lg:h-64 xl:h-72">
                <video
                  ref={cameraVideoRef}
                  className="w-full h-full object-cover"
                  playsInline
                  autoPlay
                  muted
                />
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

      {/* Footer */}
      <footer className="absolute left-0 right-0 bottom-0 h-16 px-4">
        <div className="h-full flex items-center justify-between border-t border-slate-200 bg-white/60 backdrop-blur px-2">
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            {isSessionActive ? "Recording in progress" : "Ready"}
          </div>
          <div className="flex items-center gap-3">
            <button className="px-4 py-2 rounded-full text-slate-700 bg-slate-100 hover:bg-slate-200 text-sm">
              Skip
            </button>
            {isSessionActive ? (
              <button
                onClick={stopSession}
                className="px-4 py-2 rounded-full text-white bg-red-600 hover:bg-red-700 text-sm"
              >
                Stop Session
              </button>
            ) : (
              <button
                onClick={startSession}
                className="px-4 py-2 rounded-full text-white bg-blue-600 hover:bg-blue-700 text-sm"
              >
                Start Session
              </button>
            )}
          </div>
        </div>
      </footer>
    </>
  );
}
