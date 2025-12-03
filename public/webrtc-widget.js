(function () {
    window.WebRTCWidget = function (options = {}) {
        const defaultSettings = {
            serverUrl: "https://videowidget.sozodigicare.com",
            roomId: null,
            container: null,
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
            onMessage: () => {}
        };

        let settings = { ...defaultSettings, ...options };
        const socket = io(settings.serverUrl);

        let localStream;
        let remoteStream = new MediaStream();
        let peerConnection;

        function joinRoom(roomId) {
            settings.roomId = roomId;
            socket.emit("join-room", roomId);

            socket.once("joined-room", ({ initiator }) => {
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

        function endCall() {
            if (peerConnection) peerConnection.close();
            if (localStream) localStream.getTracks().forEach(track => track.stop());
            document.querySelector('[onclick="sendCallRequest()"]')?.classList.remove("hidden");
            settings.onCallEnded();
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
