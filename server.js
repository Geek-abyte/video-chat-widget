const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Store which sockets are in which rooms
const rooms = {}; // { roomId: [socketId1, socketId2] }

io.on("connection", (socket) => {
    console.log("New user connected:", socket.id);

    socket.on("join-room", (roomId) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = [];
        }

        rooms[roomId].push(socket.id);
        const isInitiator = rooms[roomId].length === 1;

        console.log(`${socket.id} joined room ${roomId} (Initiator: ${isInitiator})`);

        socket.emit("joined-room", { initiator: isInitiator });
        socket.to(roomId).emit("user-connected", socket.id);
    });

    socket.on("offer", ({ roomId, offer }) => {
        socket.to(roomId).emit("offer", { sender: socket.id, offer });
    });

    socket.on("answer", ({ roomId, answer }) => {
        socket.to(roomId).emit("answer", { sender: socket.id, answer });
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
        socket.to(roomId).emit("ice-candidate", { sender: socket.id, candidate });
    });

    socket.on("call-request", ({ roomId }) => {
        socket.to(roomId).emit("call-request");
    });

    socket.on("call-accepted", ({ roomId }) => {
        socket.to(roomId).emit("call-accepted");
    });

    socket.on("call-rejected", ({ roomId }) => {
        socket.to(roomId).emit("call-rejected");
    });

    // Added chat-message handler
    socket.on("chat-message", ({ roomId, message, type, sender }) => {
        // console.log(`Message from ${socket.id} in room ${roomId}: ${message} and type: ${type}`);
        console.log(`Message from ${socket.id} in room ${roomId}: and type: ${type}`);

        socket.to(roomId).emit("chat-message", { sender: socket.id, message, type });
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
