const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  "http://localhost:3000,http://localhost:4000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // allow non-browser clients
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  },
});

// Store which sockets are in which rooms
const rooms = {}; // { roomId: [socketId1, socketId2] }
const MAX_ROOM_SIZE = 2;
const MAX_MESSAGE_LENGTH = 2000;

const isValidRoomId = (roomId) =>
  typeof roomId === "string" &&
  roomId.length > 0 &&
  roomId.length <= 64 &&
  /^[A-Za-z0-9_-]+$/.test(roomId);

const ensureInRoom = (roomId, socket) =>
  rooms[roomId] && rooms[roomId].includes(socket.id);

io.on("connection", (socket) => {
    console.log("New user connected:", socket.id);

    socket.on("join-room", (roomId) => {
        if (!isValidRoomId(roomId)) {
            socket.emit("room-error", { message: "Invalid room ID" });
            return;
        }

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = [];
        }

        if (rooms[roomId].length >= MAX_ROOM_SIZE) {
            socket.emit("room-error", { message: "Room is full" });
            socket.leave(roomId);
            return;
        }

        rooms[roomId].push(socket.id);
        const isInitiator = rooms[roomId].length === 1;

        console.log(`${socket.id} joined room ${roomId} (Initiator: ${isInitiator})`);

        socket.emit("joined-room", { initiator: isInitiator });
        socket.to(roomId).emit("user-connected", socket.id);
    });

    socket.on("offer", ({ roomId, offer }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("offer", { sender: socket.id, offer });
    });

    socket.on("answer", ({ roomId, answer }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("answer", { sender: socket.id, answer });
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("ice-candidate", { sender: socket.id, candidate });
    });

    socket.on("call-request", ({ roomId }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("call-request");
    });

    socket.on("call-accepted", ({ roomId }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("call-accepted");
    });

    socket.on("call-rejected", ({ roomId }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("call-rejected");
    });

    // Doctor requests to end the call; client must consent
    socket.on("call-end-request", ({ roomId }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("call-end-request", { requester: socket.id });
    });

    // Client responds to the end-call request (accept/deny)
    socket.on("call-end-consent", ({ roomId, accepted }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("call-end-consent", { responder: socket.id, accepted });
    });

    // Finalize call termination for both peers
    socket.on("call-ended", ({ roomId }) => {
        if (!ensureInRoom(roomId, socket)) return;
        socket.to(roomId).emit("call-ended", { sender: socket.id });
    });

    // Added chat-message handler
    socket.on("chat-message", ({ roomId, message, type }) => {
        if (!ensureInRoom(roomId, socket)) return;
        const safeMessage =
          typeof message === "string"
            ? message.slice(0, MAX_MESSAGE_LENGTH)
            : "";
        const safeType = typeof type === "string" ? type.slice(0, 50) : "text";

        socket.to(roomId).emit("chat-message", { sender: socket.id, message: safeMessage, type: safeType });
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);

        // Remove socket from any rooms it's part of
        for (const roomId in rooms) {
            rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
            if (rooms[roomId].length === 0) {
                delete rooms[roomId];
            }
        }
    });
});

app.use(express.static("public"));

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
