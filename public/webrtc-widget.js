(function () {
    window.WebRTCWidget = function (options = {}) {
        const defaultSettings = {
            serverUrl: "https://videowidget.sozodigicare.com",
            // serverUrl: "http://localhost:4000",
            roomId: null,
            container: null,
            role: "auto", // "auto" (initiator=doctor) | "doctor" | "client"
            requireRemoteEndConsent: true,
            iceServers: [
                {
                    urls: "stun:217.65.146.157:3478"
                },
                {
                    urls: "turn:217.65.146.157:3478?transport=udp",
                    username: "webrtcuser",
                    credential: "securepassword123"
                }
            ],
            onCallStarted: () => {},
            onCallEnded: () => {},
            onIncomingCall: () => {},
            onCallRejected: () => {},
            onCallAccepted: () => {},
            onMessage: () => {},
            onRemoteEndRequested: () => {},
            onEndRequestSent: () => {},
            onEndConsentResult: () => {},
            onConnectionStateChange: () => {}
        };

        let settings = { ...defaultSettings, ...options };
        const socket = io(settings.serverUrl, {
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000
        });

        let localStream;
        let remoteStream = new MediaStream();
        let peerConnection;
        let hasCleanedUp = false;
        let waitingForRemoteEndConsent = false;
        let consentDialogElements = null;
        let isInitiator = false;
        let callInProgress = false;
        let _endInitiatedByMe = false;

        function resetCallState() {
            hasCleanedUp = false;
            waitingForRemoteEndConsent = false;
            callInProgress = false;
            _endInitiatedByMe = false;
            remoteStream = new MediaStream();
            hideFallbackConsentDialog();
        }

        function updateConnectionStatus(state) {
            settings.onConnectionStateChange(state);
        }

        // --- Reconnection: rejoin the room if socket reconnects mid-call ---
        socket.on("connect", () => {
            console.log("🔌 Socket connected:", socket.id);
            if (settings.roomId) {
                console.log("🔄 Reconnected — rejoining room:", settings.roomId);
                socket.emit("join-room", settings.roomId);
            }
        });

        socket.on("disconnect", (reason) => {
            console.warn("⚡ Socket disconnected:", reason);
            updateConnectionStatus("reconnecting");
        });

        socket.on("reconnect_failed", () => {
            console.error("❌ Socket reconnection failed");
            updateConnectionStatus("failed");
        });

        // --- Consent dialog helpers ---
        function ensureFallbackConsentDialog() {
            if (consentDialogElements) return consentDialogElements;

            const overlay = document.createElement("div");
            overlay.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);z-index:9999;";
            overlay.setAttribute("data-webrtc-consent-overlay", "true");

            const box = document.createElement("div");
            box.style.cssText = "background:white;color:#111;border-radius:12px;padding:20px;max-width:360px;width:90%;box-shadow:0 10px 30px rgba(0,0,0,0.25);text-align:center;font-family:system-ui,-apple-system,Segoe UI,sans-serif;";

            const title = document.createElement("div");
            title.textContent = "Doctor wants to end the call";
            title.style.cssText = "font-size:18px;font-weight:700;margin-bottom:8px;";

            const body = document.createElement("div");
            body.textContent = "The call will stay active unless you agree to end it now.";
            body.style.cssText = "font-size:14px;color:#444;margin-bottom:14px;";

            const actions = document.createElement("div");
            actions.style.cssText = "display:flex;gap:10px;justify-content:center;";

            const endBtn = document.createElement("button");
            endBtn.textContent = "End call";
            endBtn.style.cssText = "background:#dc2626;color:white;border:none;border-radius:8px;padding:10px 14px;cursor:pointer;font-weight:600;";

            const stayBtn = document.createElement("button");
            stayBtn.textContent = "Stay on call";
            stayBtn.style.cssText = "background:#e5e7eb;color:#111;border:none;border-radius:8px;padding:10px 14px;cursor:pointer;font-weight:600;";

            actions.appendChild(endBtn);
            actions.appendChild(stayBtn);
            box.appendChild(title);
            box.appendChild(body);
            box.appendChild(actions);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            consentDialogElements = { overlay, endBtn, stayBtn };
            return consentDialogElements;
        }

        function showFallbackConsentDialog(accept, reject) {
            const { overlay, endBtn, stayBtn } = ensureFallbackConsentDialog();
            overlay.style.display = "flex";

            const cleanup = () => {
                overlay.style.display = "none";
                endBtn.onclick = null;
                stayBtn.onclick = null;
            };

            endBtn.onclick = () => {
                cleanup();
                accept();
            };
            stayBtn.onclick = () => {
                cleanup();
                reject();
            };
        }

        function hideFallbackConsentDialog() {
            if (consentDialogElements) {
                consentDialogElements.overlay.style.display = "none";
            }
        }

        // --- Room & Signaling ---
        function joinRoom(roomId) {
            settings.roomId = roomId;
            socket.emit("join-room", roomId);

            socket.once("joined-room", ({ initiator }) => {
                isInitiator = initiator;
                if (settings.role === "auto") {
                    settings.role = initiator ? "doctor" : "client";
                }
                console.log(`🧩 Joined room ${roomId} | Role: ${settings.role} | Initiator: ${initiator}`);
                updateConnectionStatus("waiting");

                if (!initiator) {
                    // Non-initiator waits for the offer; initiator waits for user-connected
                    console.log("⏳ Waiting for the other participant…");
                }
            });
        }

        // When a second user joins, the initiator starts the call
        socket.on("user-connected", (userId) => {
            console.log("👤 Another user connected to room:", userId);
            if (isInitiator && !callInProgress) {
                console.log("🚀 Peer joined — starting call as initiator");
                startCall();
            }
        });

        // When a user disconnects from the room
        socket.on("user-disconnected", ({ socketId }) => {
            console.warn("👤 Peer disconnected from room:", socketId);
            updateConnectionStatus("peer-disconnected");
        });

        function createPeerConnection() {
            const pc = new RTCPeerConnection({ iceServers: settings.iceServers });

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit("ice-candidate", { roomId: settings.roomId, candidate: event.candidate });
                }
            };

            // Monitor ICE connection state for reliability
            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                console.log("🧊 ICE connection state:", state);

                switch (state) {
                    case "checking":
                        updateConnectionStatus("connecting");
                        break;
                    case "connected":
                    case "completed":
                        updateConnectionStatus("connected");
                        break;
                    case "disconnected":
                        updateConnectionStatus("peer-disconnected");
                        // Attempt recovery — ICE can often self-heal
                        setTimeout(() => {
                            if (pc && pc.iceConnectionState === "disconnected") {
                                console.warn("🔄 ICE still disconnected, attempting restart…");
                                restartIce();
                            }
                        }, 3000);
                        break;
                    case "failed":
                        console.error("❌ ICE connection failed");
                        updateConnectionStatus("failed");
                        restartIce();
                        break;
                    case "closed":
                        updateConnectionStatus("ended");
                        break;
                }
            };

            pc.ontrack = (event) => {
                console.log("📹 Remote track received:", event.track.kind);

                const remoteVideoEl = document.getElementById("remoteVideo");
                if (!remoteVideoEl) {
                    console.warn("⚠️ Remote video element not found!");
                    return;
                }

                if (event.streams && event.streams[0]) {
                    remoteVideoEl.srcObject = event.streams[0];
                } else {
                    if (!remoteStream.getTracks().find(t => t.id === event.track.id)) {
                        remoteStream.addTrack(event.track);
                    }
                    remoteVideoEl.srcObject = remoteStream;
                }

                remoteVideoEl.play().catch(err => console.warn("⚠️ Remote video play:", err));
            };

            return pc;
        }

        async function restartIce() {
            if (!peerConnection || !settings.roomId) return;
            try {
                const offer = await peerConnection.createOffer({ iceRestart: true });
                await peerConnection.setLocalDescription(offer);
                socket.emit("offer", { roomId: settings.roomId, offer });
                console.log("🔄 ICE restart offer sent");
            } catch (err) {
                console.error("❌ ICE restart failed:", err);
            }
        }

        async function startCall() {
            if (!settings.roomId) {
                console.error("❌ Room ID not set.");
                return;
            }
            if (callInProgress) {
                console.log("⏭️ Call already in progress, skipping duplicate startCall");
                return;
            }

            callInProgress = true;
            resetCallState();
            callInProgress = true; // resetCallState clears this, so re-set
            updateConnectionStatus("connecting");

            try {
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 }
                    },
                    audio: true
                });

                const localVideo = document.getElementById("localVideo");
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    localVideo.play().catch(err => console.warn("⚠️ Local video play:", err));
                } else {
                    console.warn("⚠️ Local video element not found!");
                }

                peerConnection = createPeerConnection();
                localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                socket.emit("offer", { roomId: settings.roomId, offer });

                document.querySelector('[onclick="sendCallRequest()"]')?.classList.add("hidden");

            } catch (error) {
                console.error("❌ Error accessing media devices:", error);
                callInProgress = false;
                updateConnectionStatus("failed");
            }
        }

        function performEndCallCleanup({ notifyPeer = false } = {}) {
            if (hasCleanedUp) return;
            hasCleanedUp = true;

            const initiatedByMe = _endInitiatedByMe;
            _endInitiatedByMe = false;

            waitingForRemoteEndConsent = false;
            callInProgress = false;

            if (peerConnection) {
                peerConnection.onicecandidate = null;
                peerConnection.ontrack = null;
                peerConnection.oniceconnectionstatechange = null;
                peerConnection.close();
            }

            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
            }

            const localVideo = document.getElementById("localVideo");
            if (localVideo) localVideo.srcObject = null;

            const remoteVideo = document.getElementById("remoteVideo");
            if (remoteVideo) remoteVideo.srcObject = null;
            if (remoteStream) {
                remoteStream.getTracks().forEach(track => track.stop());
                remoteStream = new MediaStream();
            }

            peerConnection = null;
            localStream = null;

            if (notifyPeer && settings.roomId) {
                socket.emit("call-ended", { roomId: settings.roomId });
            }

            document.querySelector('[onclick="sendCallRequest()"]')?.classList.remove("hidden");
            updateConnectionStatus("ended");
            settings.onCallEnded({ initiatedByMe });
        }

        function requestRemoteConsentToEndCall() {
            if (waitingForRemoteEndConsent) return;
            waitingForRemoteEndConsent = true;
            socket.emit("call-end-request", { roomId: settings.roomId });
            settings.onEndRequestSent();
        }

        function respondToEndRequest(accepted) {
            waitingForRemoteEndConsent = false;
            socket.emit("call-end-consent", { roomId: settings.roomId, accepted });
            if (accepted) {
                if (settings.roomId) {
                    socket.emit("call-ended", { roomId: settings.roomId });
                }
                performEndCallCleanup({ notifyPeer: true });
            }
        }

        function endCall() {
            _endInitiatedByMe = true;
            // Client can end the call immediately — no consent needed
            if (settings.role === "client") {
                performEndCallCleanup({ notifyPeer: true });
                return;
            }
            // Doctor must request consent from the client
            if (settings.requireRemoteEndConsent) {
                requestRemoteConsentToEndCall();
                return;
            }
            performEndCallCleanup({ notifyPeer: true });
        }

        function toggleMuteAudio() {
            if (localStream) {
                const audioTrack = localStream.getAudioTracks()[0];
                if (audioTrack) {
                    audioTrack.enabled = !audioTrack.enabled;

                    const micBtnIcon = document.querySelector('[onclick="toggleMuteAudio()"] i');
                    if (micBtnIcon) {
                        micBtnIcon.setAttribute("data-lucide", audioTrack.enabled ? "mic" : "mic-off");
                        lucide.createIcons();
                    }
                }
            }
        }

        function toggleMuteVideo() {
            if (localStream) {
                const videoTrack = localStream.getVideoTracks()[0];
                if (videoTrack) {
                    videoTrack.enabled = !videoTrack.enabled;

                    const camBtnIcon = document.querySelector('[onclick="toggleMuteVideo()"] i');
                    if (camBtnIcon) {
                        camBtnIcon.setAttribute("data-lucide", videoTrack.enabled ? "video" : "video-off");
                        lucide.createIcons();
                    }

                    const localVideo = document.getElementById("localVideo");
                    if (localVideo) {
                        localVideo.style.display = videoTrack.enabled ? "block" : "none";
                    }
                }
            }
        }

        function sendMessage(data) {
            if (!settings.roomId || !data) return;

            const messagePayload = typeof data === 'string'
                ? { message: data, type: "text", sender: socket.id }
                : data;

            if (!messagePayload.sender) messagePayload.sender = socket.id;
            socket.emit("chat-message", { roomId: settings.roomId, ...messagePayload });
        }

        socket.on("chat-message", (data) => {
            if (typeof settings.onMessage === "function") {
                settings.onMessage(data);
            }
        });

        socket.on("offer", async ({ offer }) => {
            console.log("📩 Incoming offer…");

            // Prevent processing offers if we already have an active call as initiator
            // (this avoids collisions when both sides send offers)
            if (callInProgress && isInitiator) {
                console.log("⏭️ Already in a call as initiator, ignoring duplicate offer");
                return;
            }

            callInProgress = true;
            resetCallState();
            callInProgress = true;
            updateConnectionStatus("connecting");

            peerConnection = createPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

            try {
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 }
                    },
                    audio: true
                });

                const localVideo = document.getElementById("localVideo");
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    localVideo.play().catch(err => console.warn("⚠️ Local video play:", err));
                }

                localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit("answer", { roomId: settings.roomId, answer });
            } catch (error) {
                console.error("❌ Error accessing media for answer:", error);
                callInProgress = false;
                updateConnectionStatus("failed");
            }
        });

        socket.on("answer", async ({ answer }) => {
            if (peerConnection) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                console.log("✅ Answer received and set.");
            }
        });

        socket.on("ice-candidate", ({ candidate }) => {
            if (peerConnection) {
                peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => {
                    console.warn("⚠️ Failed to add ICE candidate:", err);
                });
            }
        });

        socket.on("call-end-request", () => {
            if (typeof settings.onRemoteEndRequested === "function") {
                settings.onRemoteEndRequested({
                    accept: () => respondToEndRequest(true),
                    reject: () => respondToEndRequest(false)
                });
            } else {
                showFallbackConsentDialog(
                    () => respondToEndRequest(true),
                    () => respondToEndRequest(false)
                );
            }
        });

        socket.on("call-end-consent", ({ accepted }) => {
            waitingForRemoteEndConsent = false;
            settings.onEndConsentResult(accepted);
            if (accepted) {
                if (settings.roomId) {
                    socket.emit("call-ended", { roomId: settings.roomId });
                }
                performEndCallCleanup({ notifyPeer: true });
            }
        });

        socket.on("call-ended", () => {
            waitingForRemoteEndConsent = false;
            performEndCallCleanup();
        });

        function sendCallRequest() {
            socket.emit("call-request", { roomId: settings.roomId });
        }

        function acceptCall() {
            socket.emit("call-accepted", { roomId: settings.roomId });
            startCall();
        }

        function rejectCall() {
            socket.emit("call-rejected", { roomId: settings.roomId });
        }

        socket.on("call-request", () => {
            document.getElementById("incomingCall")?.classList.remove("hidden");
        });

        socket.on("call-rejected", () => {
            alert("Call was rejected.");
            document.getElementById("ringingIndicator")?.classList.add("hidden");
        });

        socket.on("call-accepted", () => {
            document.getElementById("ringingIndicator")?.classList.add("hidden");
        });

        return {
            sendCallRequest,
            acceptCall,
            rejectCall,
            startCall,
            endCall,
            forceEndCall: () => performEndCallCleanup({ notifyPeer: true }),
            toggleMuteAudio,
            toggleMuteVideo,
            joinRoom,
            sendMessage,
            restartIce,
            get localStream() {
                return localStream;
            },
            get socketId() {
                return socket.id;
            }
        };
    };
})();
