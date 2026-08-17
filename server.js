const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const SERVER_SECRET = process.env.SERVER_SECRET || "ETFD23";

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let chatLogs = [];

// Serve Dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));

// 1. FIX: Combined GET endpoints for frontend polling
app.get(['/api/chat', '/api/chat/logs'], (req, res) => {
    res.json(chatLogs);
});

// 2. Roblox Telemetry Endpoint
app.post('/api/roblox/chat', (req, res) => {
    const incomingSecret = req.headers['x-server-secret'];
    if (incomingSecret !== SERVER_SECRET) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    const { userId, username, msg, ageDays } = req.body;
    if (!username || !msg) return res.status(400).json({ error: "Invalid data" });

    if (username === "SYSTEM_TEST") {
        return res.status(200).json({ status: "Diagnostic Ping Received" });
    }

    const chatData = {
        id: Date.now(),
        userId: userId || "0",
        username: username,
        msg: msg,
        ageDays: ageDays || 0,
        time: new Date().toLocaleTimeString()
    };

    chatLogs.unshift(chatData);
    if (chatLogs.length > 100) chatLogs.pop();

    io.emit('newChatMessage', chatData);
    return res.status(200).json({ status: "Success" });
});

server.listen(PORT, () => console.log(`ETFD Active on ${PORT}`));