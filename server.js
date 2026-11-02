const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const GENDERS = ['male', 'female'];
const opposite = (g) => (g === 'male' ? 'female' : 'male');

// online = everyone who picked a gender and is on the site
// queues = people currently waiting for a match
const online = { male: new Set(), female: new Set() };
const queues = { male: [], female: [] };

function broadcastCounts() {
  io.emit('counts', {
    male: online.male.size,
    female: online.female.size,
    waitingMale: queues.male.length,
    waitingFemale: queues.female.length
  });
}

function removeFromQueues(socket) {
  for (const g of GENDERS) {
    const i = queues[g].indexOf(socket);
    if (i > -1) queues[g].splice(i, 1);
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

  const waiting = queues[opposite(socket.gender)];
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
    socket.emit('matched');
    partner.emit('matched');
  } else {
    queues[socket.gender].push(socket);
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
  socket.partner = null;
  socket.blocked = new Set();
  socket.lastMsg = 0;

  socket.emit('counts', {
    male: online.male.size,
    female: online.female.size,
    waitingMale: queues.male.length,
    waitingFemale: queues.female.length
  });

  // user picked gender and confirmed 18+
  socket.on('join', ({ gender, adult } = {}) => {
    if (!GENDERS.includes(gender) || adult !== true) return;
    goOffline(socket);
    socket.gender = gender;
    online[gender].add(socket.id);
    socket.emit('joined', { gender });
    broadcastCounts();
  });

  // start searching / press Next
  socket.on('find', () => {
    if (!socket.gender) return;
    findMatch(socket);
  });

  // stop chatting and go idle
  socket.on('stop', () => {
    if (!socket.gender) return;
    removeFromQueues(socket);
    leavePartner(socket, true);
    socket.emit('idle');
    broadcastCounts();
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
    console.log(`[REPORT] ${new Date().toISOString()} reporter=${socket.id}(${socket.gender}) reported=${p.id}(${p.gender})`);
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
