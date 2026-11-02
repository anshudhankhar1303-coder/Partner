const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const GENDERS = ['male', 'female'];
const MODES = ['text', 'video'];
const opposite = (g) => (g === 'male' ? 'female' : 'male');

// online = everyone who picked a gender and is on the site
// queues = people waiting for a match, separate for text and video
const online = { male: new Set(), female: new Set() };
const queues = {
  text: { male: [], female: [] },
  video: { male: [], female: [] }
};

function counts() {
  return {
    male: online.male.size,
    female: online.female.size,
    waitingMale: queues.text.male.length + queues.video.male.length,
    waitingFemale: queues.text.female.length + queues.video.female.length
  };
}

function broadcastCounts() {
  io.emit('counts', counts());
}

function removeFromQueues(socket) {
  for (const m of MODES) {
    for (const g of GENDERS) {
      const i = queues[m][g].indexOf(socket);
      if (i > -1) queues[m][g].splice(i, 1);
    }
  }
}

function leavePartner(socket, notify) {
  const p = socket.partner;
  if (!p) return;
  socket.partner = null;
  p.partner = null;
  if (notify) p.emit('partner-left');
}

function findMatch(socket) {
  leavePartner(socket, true);
  removeFromQueues(socket);

  const waiting = queues[socket.mode][opposite(socket.gender)];
  const idx = waiting.findIndex(
    (p) =>
      p.connected &&
      p.id !== socket.id &&
      !socket.blocked.has(p.id) &&
      !p.blocked.has(socket.id)
  );

  if (idx > -1) {
    const partner = waiting.splice(idx, 1)[0];
    socket.partner = partner;
    partner.partner = socket;
    // the person who just arrived starts the video call (creates the offer)
    socket.emit('matched', { mode: socket.mode, initiator: true });
    partner.emit('matched', { mode: partner.mode, initiator: false });
  } else {
    queues[socket.mode][socket.gender].push(socket);
    socket.emit('searching');
  }
  broadcastCounts();
}

function goOffline(socket) {
  removeFromQueues(socket);
  leavePartner(socket, true);
  if (socket.gender) online[socket.gender].delete(socket.id);
  socket.gender = null;
}

io.on('connection', (socket) => {
  socket.gender = null;
  socket.mode = 'text';
  socket.partner = null;
  socket.blocked = new Set();
  socket.lastMsg = 0;

  socket.emit('counts', counts());

  // user picked gender and confirmed 18+
  socket.on('join', ({ gender, adult } = {}) => {
    if (!GENDERS.includes(gender) || adult !== true) return;
    goOffline(socket);
    socket.gender = gender;
    online[gender].add(socket.id);
    socket.emit('joined', { gender });
    broadcastCounts();
  });

  // start searching / press Next, with mode 'text' or 'video'
  socket.on('find', ({ mode } = {}) => {
    if (!socket.gender) return;
    socket.mode = MODES.includes(mode) ? mode : 'text';
    findMatch(socket);
  });

  // stop chatting but stay on the site
  socket.on('stop', () => {
    if (!socket.gender) return;
    removeFromQueues(socket);
    leavePartner(socket, true);
    socket.emit('idle');
    broadcastCounts();
  });

  // go back to the home screen (change mode / gender)
  socket.on('leave', () => {
    goOffline(socket);
    broadcastCounts();
  });

  // WebRTC signaling: pass offer/answer/ICE candidates to the partner
  socket.on('signal', (data) => {
    if (!socket.partner || socket.mode !== 'video' || !data || typeof data !== 'object') return;
    const out = {};
    if (data.sdp && typeof data.sdp === 'object') out.sdp = data.sdp;
    if (data.candidate && typeof data.candidate === 'object') out.candidate = data.candidate;
    if (out.sdp || out.candidate) socket.partner.emit('signal', out);
  });

  socket.on('message', (text) => {
    if (!socket.partner || typeof text !== 'string') return;
    const now = Date.now();
    if (now - socket.lastMsg < 250) return; // basic flood control
    socket.lastMsg = now;
    const clean = text.trim().slice(0, 500);
    if (!clean) return;
    socket.partner.emit('message', clean);
  });

  socket.on('typing', (isTyping) => {
    if (socket.partner) socket.partner.emit('typing', !!isTyping);
  });

  socket.on('report', () => {
    const p = socket.partner;
    if (!p) return;
    socket.blocked.add(p.id);
    p.blocked.add(socket.id);
    console.log(`[REPORT] ${new Date().toISOString()} mode=${socket.mode} reporter=${socket.id}(${socket.gender}) reported=${p.id}(${p.gender})`);
    leavePartner(socket, true);
    socket.emit('reported');
  });

  socket.on('disconnect', () => {
    goOffline(socket);
    broadcastCounts();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Saamne running on http://localhost:${PORT}`));
