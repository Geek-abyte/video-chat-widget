(function () {
    window.WebRTCWidget = function (options = {}) {
        const defaultSettings = {
            // serverUrl: "https://videowidget.sozodigicare.com",
            serverUrl: "http://localhost:4000",
            roomId: null,
            container: null,
            role: "auto", // "auto" (initiator=doctor) | "doctor" | "client"
            requireRemoteEndConsent: true, // when doctor ends, client must consent
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
            onEndConsentResult: () => {}
        };

        let settings = { ...defaultSettings, ...options };
        const socket = io(settings.serverUrl);

        let localStream;
        let remoteStream = new MediaStream();
        let peerConnection;
        let hasCleanedUp = false;
        let waitingForRemoteEndConsent = false;
        let consentDialogElements = null;

        function resetCallState() {
            hasCleanedUp = false;
            waitingForRemoteEndConsent = false;
            remoteStream = new MediaStream();
            hideFallbackConsentDialog();
        }

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

        function joinRoom(roomId) {
            settings.roomId = roomId;
            socket.emit("join-room", roomId);

            socket.once("joined-room", ({ initiator }) => {
                if (settings.role === "auto") {
                    settings.role = initiator ? "doctor" : "client";
                }
                console.log(`🧩 Joined room ${roomId} | Initiator: ${initiator}`);
                if (initiator) {
                    startCall();
                }
            });
        }

        function createPeerConnection() {
            const pc = new RTCPeerConnection({ iceServers: settings.iceServers });

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit("ice-candidate", { roomId: settings.roomId, candidate: event.candidate });
                }
            };

            pc.ontrack = (event) => {
                event.streams[0].getTracks().forEach(track => {
                    remoteStream.addTrack(track);
                });

                const remoteVideo = document.getElementById("remoteVideo");
                if (remoteVideo) {
                    remoteVideo.srcObject = event.streams[0];
                }
            };

            return pc;
        }

        async function startCall() {
            if (!settings.roomId) {
                console.error("❌ Room ID not set. Call joinRoom(roomId) first.");
                return;
            }

            resetCallState();

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
                    console.log("✅ Local video stream set.");
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
            }
        }

        function performEndCallCleanup({ notifyPeer = false } = {}) {
            if (hasCleanedUp) return;
            hasCleanedUp = true;
            waitingForRemoteEndConsent = false;

            if (peerConnection) {
                peerConnection.onicecandidate = null;
                peerConnection.ontrack = null;
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
            settings.onCallEnded();
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
                // Proactively notify peer before cleanup in case socket disconnects on teardown.
                if (settings.roomId) {
                    socket.emit("call-ended", { roomId: settings.roomId });
                }
                performEndCallCleanup({ notifyPeer: true });
            }
        }

        function endCall() {
            // If consent is required, always request it before ending.
            // This covers all doctor end-buttons and any custom wiring.
            if (settings.requireRemoteEndConsent) {
                console.log("🔒 Requesting remote consent to end call...");
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
                ? { message: data, type: "text", sender: sessionStorage.getItem("mySocketId") }
                : data;

            socket.emit("chat-message", { roomId: settings.roomId, ...messagePayload });
        }

        socket.on("chat-message", (data) => {
            if (typeof settings.onMessage === "function") {
                settings.onMessage(data);
            } else {
                console.log(`[📨] Message from ${data?.sender || 'peer'}:`, data?.message);
            }
        });

        socket.on("offer", async ({ offer }) => {
            console.log("📩 Incoming call...");

            resetCallState();
            peerConnection = createPeerConnection();
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

            const localVideo = document.getElementById("localVideo");
            if (localVideo) {
                localVideo.srcObject = localStream;
                console.log("✅ Local video stream set (receiver).");
            }

            localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit("answer", { roomId: settings.roomId, answer });
        });

        socket.on("answer", async ({ answer }) => {
            if (peerConnection) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
                console.log("✅ Answer received and set.");
            }
        });

        socket.on("ice-candidate", ({ candidate }) => {
            if (peerConnection) {
                peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            }
        });

        socket.on("call-end-request", () => {
            if (typeof settings.onRemoteEndRequested === "function") {
                settings.onRemoteEndRequested({
                    accept: () => respondToEndRequest(true),
                    reject: () => respondToEndRequest(false)
                });
            } else {
                // Built-in modal to force explicit consent on the client side.
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
                // Ensure both sides get torn down, and send final call-ended to peer.
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
            toggleMuteAudio,
            toggleMuteVideo,
            joinRoom,
            sendMessage,
            get localStream() {
                return localStream;
            }
        };
    };
})();
