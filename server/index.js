// The Whispiverse server. It owns the world: where everyone is, the sparks that drift
// through it, who has collected what, and the topics with their draining time.
// Clients send where they are and what they want to do. Voice never passes through here:
// it goes peer to peer, and the server only tells clients who else is in the room.
//
// It also serves the built client from ../dist, so one process is the whole deployment.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 4100);
const WORLD = 85;            // sparks and topics live within this distance of the centre
const SPARKS = 90;
const EAT_RADIUS = 2.4;      // a comet this close to a spark collects it
const MAGNET = 13;           // a spark this close to a comet is pulled toward it
const PORTAL_COST = 3;       // sparks it takes to open a topic
const PORTAL_ENERGY = 75;    // seconds a new topic lives without being fed
const FEED_GAIN = 20;        // seconds one spark adds
const PORTAL_MAX = 180;
const ZONE = 17;             // a topic's zone: inside this distance of its portal you can talk, and feed it
const PORTAL_SPACING = 44;   // a new topic cannot be opened closer than this to another, so zones never touch
const LOW = 30;              // a topic with less time than this is running out
const IMAGE_LIMIT = 300 * 1024;
const THREAD_KEEPS = 8;

const players = {};          // id -> { id, name, hue, p: [x, y, z], score, bot? }
const portals = [];          // { id, owner, name, description, image, p: [x, y, z], energy, thread }
const sparks = [];           // { p: [x, y, z], to: [x, y, z], speed }
let nextPortal = 1;

const rand = (span) => (Math.random() - 0.5) * 2 * span;
const somewhere = () => [rand(WORLD), rand(WORLD * 0.2), rand(WORLD)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// Distance seen from above. Topics are kept apart by this one, so their zones do not
// overlap on the map either.
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const clean = (text, max) => String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

for (let i = 0; i < SPARKS; i++) sparks.push({ p: somewhere(), to: somewhere(), speed: 1.5 + Math.random() * 2.5 });

// ---- Static files: the built client.
const DIST = path.join(__dirname, '..', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gltf': 'model/gltf+json', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, players: Object.keys(players).length, portals: portals.length, sparks: sparks.length }));
  }
  const file = path.join(DIST, path.normalize(url === '/' ? '/index.html' : url));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found. Build the client with `npm run build`, or run `npm run dev`.'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });
const publicPortal = (p) => ({ id: p.id, owner: p.owner, name: p.name, description: p.description, image: p.image, p: p.p, energy: p.energy, thread: p.thread || [] });

// Talking happens at topics. A whisper can only be said inside a topic's zone, everyone in
// that zone gets it, and it is kept in the topic's thread for whoever arrives later.
const zoneOf = (p) => portals.filter((t) => dist(t.p, p) < ZONE).sort((x, y) => dist(x.p, p) - dist(y.p, p))[0] || null;
function whisper(from, text) {
  const topic = zoneOf(from.p);
  if (!topic) return false;
  const line = { id: from.id, name: from.name, text, topic: topic.id };
  for (const [id, socket] of io.sockets.sockets) {
    const listener = players[id];
    if (listener && dist(listener.p, topic.p) < ZONE) socket.emit('whisper', line);
  }
  topic.thread = (topic.thread || []).concat({ name: from.name, text }).slice(-THREAD_KEEPS);
  io.emit('portal:thread', { id: topic.id, thread: topic.thread });
  return true;
}

function plantPortal(owner, at, name, description, image) {
  const portal = { id: nextPortal++, owner, name, description, image: image || '', p: at.slice(), energy: PORTAL_ENERGY, thread: [] };
  portals.push(portal);
  io.emit('portals', portals.map(publicPortal));
  return portal;
}

io.on('connection', (socket) => {
  socket.on('join', (who) => {
    const me = { id: socket.id, name: clean(who && who.name, 18) || 'comet', hue: Math.floor(Math.random() * 360), p: [rand(6), rand(3), rand(6)], score: 0 };
    players[socket.id] = me;
    socket.emit('welcome', { me, players: Object.values(players), portals: portals.map(publicPortal), sparks: sparks.map((s) => s.p), rules: { zone: ZONE, cost: PORTAL_COST, feed: FEED_GAIN, spacing: PORTAL_SPACING, world: WORLD } });
    socket.broadcast.emit('player:joined', me);
  });

  socket.on('move', (p) => {
    const me = players[socket.id];
    if (!me || !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return;
    me.p = p;
  });

  // At most one whisper a second from anyone, and only inside a topic's zone.
  let lastWhisper = 0;
  socket.on('whisper', (text, reply) => {
    const me = players[socket.id];
    const answer = typeof reply === 'function' ? reply : () => {};
    const line = clean(text, 140);
    if (!me || !line || Date.now() - lastWhisper < 1000) return answer({ error: 'Too fast.' });
    lastWhisper = Date.now();
    answer(whisper(me, line) ? { ok: true } : { error: 'You can only talk inside a topic.' });
  });

  // Opening a topic costs sparks, and needs room around it.
  socket.on('portal:create', (data, reply) => {
    const me = players[socket.id];
    const answer = typeof reply === 'function' ? reply : () => {};
    if (!me) return answer({ error: 'Not in the world.' });
    if (me.score < PORTAL_COST) return answer({ error: `A topic costs ${PORTAL_COST} sparks.` });
    if (portals.some((p) => flat(p.p, me.p) < PORTAL_SPACING)) return answer({ error: 'Too close to another topic. Fly further out.' });
    const name = clean(data && data.name, 60);
    if (!name) return answer({ error: 'A topic needs a name.' });
    const image = data && typeof data.image === 'string' && data.image.startsWith('data:image/') && data.image.length < IMAGE_LIMIT * 1.4 ? data.image : '';
    me.score -= PORTAL_COST;
    const portal = plantPortal(me.name, me.p, name, clean(data.description, 240), image);
    io.emit('score', { id: me.id, score: me.score });
    answer({ ok: true, id: portal.id });
  });

  // Feeding spends one spark to buy the topic time. You have to be in its zone.
  socket.on('portal:feed', (id, reply) => {
    const me = players[socket.id];
    const answer = typeof reply === 'function' ? reply : () => {};
    const portal = portals.find((p) => p.id === id);
    if (!me || !portal) return answer({ error: 'No such topic.' });
    if (me.score < 1) return answer({ error: 'No sparks to feed it with.' });
    if (dist(portal.p, me.p) > ZONE) return answer({ error: 'Too far from it.' });
    me.score -= 1;
    portal.energy = Math.min(PORTAL_MAX, portal.energy + FEED_GAIN);
    io.emit('portal:fed', { id: portal.id, energy: portal.energy, by: me.id });
    io.emit('score', { id: me.id, score: me.score });
    answer({ ok: true });
  });

  socket.on('disconnect', () => {
    if (!players[socket.id]) return;
    delete players[socket.id];
    io.emit('player:left', socket.id);
  });
});

// ---- Simulated comets. An empty sky is a poor forum, so the server can fly comets of its
// own (BOTS=n, 14 by default, 0 for none). They are marked as simulated to everyone. They
// do what a player does, through the same rules: chase sparks, open a topic when they can
// afford one, feed a topic that is running low, and stop at topics to talk.
const BOTS = Number(process.env.BOTS === undefined ? 14 : process.env.BOTS);
const BOT_NAMES = ['halley', 'encke', 'swift', 'tuttle', 'hale', 'bopp', 'lovejoy', 'wild', 'biela', 'faye', 'wolf', 'kopff', 'borrelly', 'tempel', 'holmes', 'finlay'];
// Each topic comes with a few things a simulated comet can say in it.
const TOPICS = [
  ['What are you building this week?', 'Half-finished things welcome.', ['A tiny synth that runs in a tab.', 'Still arguing with my build config.', 'A map of the trees on my street.', 'Nothing yet. I came for ideas.']],
  ['Music to work to', 'One record, and why it works for you.', ['Anything without words.', 'Rain sounds, honestly.', 'The same album since March.', 'Film scores, loud.']],
  ['Show your worst bug', 'The longer it took to find, the better.', ['Off by one. Three days.', 'It only failed on Tuesdays.', 'A timezone, of course.', 'The cache was right. I was wrong.']],
  ['Is the web still fun?', 'Make the case either way.', ['It is when you make small things.', 'View source used to teach you everything.', 'Yes. This is a web page.', 'Ask me after the next rewrite.']],
  ['Small games worth an evening', 'Under two hours, no tutorials.', ['Anything with one good idea.', 'The short ones stay with you.', 'I want a list. Keep going.', 'Co-op on one keyboard.']],
  ['Things learned the hard way', 'What you would tell yourself a year ago.', ['Write it down the day it happens.', 'Ship the small one first.', 'Sleep before you debug.', 'Ask sooner.']],
  ['Tools you stopped using', 'And what replaced them, if anything.', ['Most of my plugins.', 'A notes app. Now it is one text file.', 'Three task managers in a row.', 'Nothing replaced it. That was the point.']],
  ['A place you keep going back to', 'Real or not.', ['A bench by a river.', 'The level select screen of an old game.', 'A kitchen that smelled of bread.', 'A train window.']],
];
const FED_TALK = ['Left a spark so this one stays open.', 'Fed it. It was nearly gone.', 'This one is worth keeping.'];
const bots = [];
for (let i = 0; i < BOTS; i++) {
  const id = 'sim-' + i;
  players[id] = { id, name: BOT_NAMES[i % BOT_NAMES.length], hue: (i * 83) % 360, p: somewhere(), score: 0, bot: true };
  bots.push({ me: players[id], aim: null, wait: 0, at: null, visit: null, turn: 0, talkIn: 3, ring: 6 + Math.random() * 7, pace: (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.3), speed: 7 + Math.random() * 4 });
}
function steerBots(dt) {
  bots.forEach((bot) => {
    const me = bot.me;
    // Stopping at a topic: circle inside its zone for a while, saying something now and then.
    if (bot.wait > 0) {
      bot.wait -= dt;
      const topic = bot.at && portals.includes(bot.at) ? bot.at : null;
      if (topic) {
        bot.talkIn -= dt;
        if (bot.talkIn <= 0) {
          bot.talkIn = 5 + Math.random() * 9;
          const lines = topic.lines || FED_TALK;
          whisper(me, lines[Math.floor(Math.random() * lines.length)]);
        }
        bot.turn += dt * bot.pace;
        const goal = [topic.p[0] + Math.cos(bot.turn) * bot.ring, topic.p[1] + Math.sin(bot.turn * 0.7) * 3, topic.p[2] + Math.sin(bot.turn) * bot.ring];
        for (let k = 0; k < 3; k++) me.p[k] += (goal[k] - me.p[k]) * Math.min(1, dt * 1.5);
      }
      return;
    }
    bot.at = null;
    // Now and then, drop in on a topic that is open.
    if (portals.length && !bot.visit && Math.random() < 0.012) bot.visit = portals[Math.floor(Math.random() * portals.length)];
    if (bot.visit && !portals.includes(bot.visit)) bot.visit = null;
    // Open a topic now and then, when it can afford one and there is room.
    if (me.score >= PORTAL_COST && portals.length < 7 && Math.random() < 0.01 && !portals.some((p) => flat(p.p, me.p) < PORTAL_SPACING)) {
      const unused = TOPICS.filter((t) => !portals.some((p) => p.name === t[0]));
      if (unused.length) {
        const topic = unused[Math.floor(Math.random() * unused.length)];
        me.score -= PORTAL_COST;
        const made = plantPortal(me.name, me.p, topic[0], topic[1]);
        made.lines = topic[2];
        io.emit('score', { id: me.id, score: me.score });
        bot.at = made; bot.wait = 10; bot.talkIn = 2; bot.aim = null;
        bot.turn = 0;
        return;
      }
    }
    // A topic that is running out, and sparks in hand: go and feed it.
    const fading = me.score > 0 ? portals.filter((p) => p.energy < LOW).sort((a, b) => dist(a.p, me.p) - dist(b.p, me.p))[0] : null;
    const stop = fading || bot.visit;
    let goal;
    if (stop) {
      goal = stop.p;
      if (dist(goal, me.p) < bot.ring + 2) {
        if (stop === fading) {
          me.score -= 1;
          fading.energy = Math.min(PORTAL_MAX, fading.energy + FEED_GAIN);
          io.emit('portal:fed', { id: fading.id, energy: fading.energy, by: me.id });
          io.emit('score', { id: me.id, score: me.score });
        }
        bot.at = stop; bot.visit = null;
        bot.turn = Math.atan2(me.p[2] - stop.p[2], me.p[0] - stop.p[0]);
        bot.wait = 12 + Math.random() * 20;
        bot.talkIn = 1 + Math.random() * 5;
        if (stop === fading && Math.random() < 0.5) whisper(me, FED_TALK[Math.floor(Math.random() * FED_TALK.length)]);
        return;
      }
    } else {
      // Otherwise chase a spark nearby, keeping to one until it is caught or gone.
      if (!bot.aim || dist(bot.aim.p, me.p) > 70) bot.aim = sparks.slice().sort((a, b) => dist(a.p, me.p) - dist(b.p, me.p))[Math.floor(Math.random() * 3)];
      goal = bot.aim.p;
    }
    const d = dist(goal, me.p);
    if (d > 0.01) for (let k = 0; k < 3; k++) me.p[k] += (goal[k] - me.p[k]) / d * Math.min(d, bot.speed * dt);
  });
}

// ---- The world's clock.
// Sparks drift toward a point and pick a new one when they arrive. A comet that touches
// one collects it, and the spark starts again somewhere else.
const STEP = 1 / 15;
setInterval(() => {
  steerBots(STEP);
  const list = Object.values(players);
  sparks.forEach((spark, index) => {
    // A comet pulls the sparks around it: inside MAGNET a spark leaves its drift and falls
    // toward the nearest comet, faster the closer it is.
    let pull = null, pullD = MAGNET;
    for (const player of list) { const away = dist(spark.p, player.p); if (away < pullD) { pullD = away; pull = player; } }
    const d = dist(spark.p, spark.to);
    if (pull) {
      const speed = 5 + (1 - pullD / MAGNET) * 22;
      for (let k = 0; k < 3; k++) spark.p[k] += (pull.p[k] - spark.p[k]) / (pullD || 1) * Math.min(pullD, speed * STEP);
    } else if (d < 0.5) spark.to = somewhere();
    else for (let k = 0; k < 3; k++) spark.p[k] += (spark.to[k] - spark.p[k]) / d * spark.speed * STEP;
    for (const player of list) {
      if (dist(spark.p, player.p) < EAT_RADIUS) {
        player.score += 1;
        spark.p = somewhere(); spark.to = somewhere();
        io.emit('spark:eaten', { index, by: player.id, score: player.score });
        bots.forEach((b) => { if (b.aim === spark) b.aim = null; });
        break;
      }
    }
  });
  if (list.some((p) => !p.bot)) {
    io.volatile.emit('tick', {
      players: list.map((p) => [p.id, +p.p[0].toFixed(2), +p.p[1].toFixed(2), +p.p[2].toFixed(2)]),
      sparks: sparks.map((s) => [+s.p[0].toFixed(2), +s.p[1].toFixed(2), +s.p[2].toFixed(2)]),
    });
  }
}, STEP * 1000);

// With simulated comets on, four topics are already open when the server starts, one of
// them close to where a new comet arrives.
if (BOTS > 0) {
  const names = bots.map((b) => b.me.name);
  [[-10, 2, -30], [46, 6, -48], [-58, -6, 14], [18, 9, 58]].forEach((at, i) => {
    const made = plantPortal(names[i % names.length], at, TOPICS[i][0], TOPICS[i][1]);
    made.lines = TOPICS[i][2];
    made.energy = 120 - i * 20;
  });
}

// Topics lose a second of time every second, and one that runs out is gone.
setInterval(() => {
  let died = false;
  for (let i = portals.length - 1; i >= 0; i--) {
    portals[i].energy -= 1;
    if (portals[i].energy <= 0) { portals.splice(i, 1); died = true; }
  }
  if (died) io.emit('portals', portals.map(publicPortal));
  else if (portals.length) io.volatile.emit('portal:energy', portals.map((p) => [p.id, p.energy]));
}, 1000);

server.listen(PORT, () => console.log(`Whispiverse server on http://localhost:${PORT}`));
