// The Whispiverse server. It owns the world: where everyone is, the sparks that drift
// through it, who has collected what, the topics with their draining time, and who has
// scattered whom. Clients send where they are and what they want to do. Voice never passes
// through here: it goes peer to peer, and the server only tells clients who else is in the room.
//
// It also serves the built client from ../dist, so one process is the whole deployment.
// The simulated comets are in sims.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 4100);
const WORLD = 85;            // sparks and topics live within this distance of the centre
// The economy, in one place.
//   Sparks are found in open sky, where they can be knocked out of you. What you carry
//   shows beside your comet, so a loaded comet is a known target.
//   Sparks are only good for one thing: topics. Five open one, one buys an open one time.
//   A spark spent is gone from your hand for good, and counted for good: your "given"
//   total is what you have put into the sky's conversations, and nobody can take it.
//   A topic grows with what it is fed. At 10 sparks and at 25 it gains a level, and a
//   higher level can hold more time, so a room people care about gets harder to lose.
// So the loop is: gather at risk, carry it to a topic, spend it there. Hoarding only
// makes you a target, and hunting only pays if you then go and spend what you took.
const SPARKS = 80;
const EAT_RADIUS = 3.2;      // a comet this close to a spark collects it
const MAGNET = 15;           // a spark this close to a comet is pulled toward it
const PORTAL_COST = 5;       // sparks it takes to open a topic
const PORTAL_ENERGY = 90;    // seconds a new topic lives without being fed
const FEED_GAIN = 15;        // seconds one spark adds
const LEVELS = [{ at: 0, cap: 120 }, { at: 10, cap: 200 }, { at: 25, cap: 320 }];   // sparks fed to reach a level, and the time it can then hold
const levelOf = (fed) => LEVELS.filter((l) => fed >= l.at).length;
const ZONE = 17;             // a topic's zone: inside this distance of its portal you can talk, and feed it
const PORTAL_SPACING = 44;   // a new topic cannot be opened closer than this to another, so zones never touch
// Combat. Open sky is dangerous, topics are safe: a comet that dashes into another one
// outside every zone scatters it. The one hit drops all its sparks where it was, is gone
// for a few seconds, and comes back somewhere else with a short shield. So sparks are only
// safe once they are spent on a topic, and carrying a lot of them makes you worth hunting.
const DASH_MS = 450;         // how long a dash lasts
const DASH_EVERY = 2500;     // and how often one can be made
const HIT_RADIUS = 4.6;      // a dashing comet this close to another scatters it
const DOWN_MS = 3000;        // time out of the sky after being scattered
const SHIELD_MS = 4000;      // time after coming back during which nothing can hit you
const DROP_MAX = 24;         // sparks one scatter can throw out
const IMAGE_LIMIT = 300 * 1024;
const THREAD_KEEPS = 40;     // lines of talk a topic remembers

const players = {};          // id -> { id, name, hue, p: [x, y, z], score, bot?, role? }
const portals = [];          // { id, owner, name, description, image, p: [x, y, z], energy, thread }
const sparks = [];           // { p: [x, y, z], to: [x, y, z], speed }
let nextPortal = 1;

const rand = (span) => (Math.random() - 0.5) * 2 * span;
const somewhere = () => [rand(WORLD), rand(WORLD * 0.45), rand(WORLD)];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clean = (text, max) => String(text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

for (let i = 0; i < SPARKS; i++) sparks.push({ p: somewhere(), to: somewhere(), speed: 1.5 + Math.random() * 2.5 });

// ---- Static files: the built client.
const DIST = path.join(__dirname, '..', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gltf': 'model/gltf+json', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, players: Object.keys(players).length, portals: portals.length, sparks: sparks.length, stepMs: +stepCost.toFixed(2) }));
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
const publicPortal = (p) => ({ id: p.id, owner: p.owner, name: p.name, description: p.description, image: p.image, p: p.p, energy: p.energy, fed: p.fed || 0, level: levelOf(p.fed || 0), cap: LEVELS[levelOf(p.fed || 0) - 1].cap, thread: p.thread || [] });
const publicPlayer = (p) => ({ id: p.id, name: p.name, hue: p.hue, p: p.p, score: p.score, given: p.given || 0, bot: !!p.bot, role: p.role || '' });
// A spark spent on a topic is counted to whoever spent it, for good.
const give = (me, n) => { me.given = (me.given || 0) + n; io.emit('given', { id: me.id, given: me.given }); };
let sims = null;

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
  topic.thread = (topic.thread || []).concat({ id: from.id, name: from.name, hue: from.hue, bot: !!from.bot, text, t: Date.now() }).slice(-THREAD_KEEPS);
  io.emit('portal:thread', { id: topic.id, thread: topic.thread });
  if (!from.bot && sims) sims.heard(topic, from);
  return true;
}

function plantPortal(owner, at, name, description, image) {
  const portal = { id: nextPortal++, owner, name, description, image: image || '', p: at.slice(), energy: PORTAL_ENERGY, fed: 0, thread: [] };
  portals.push(portal);
  io.emit('portals', portals.map(publicPortal));
  return portal;
}

// One spark buys a topic time. Whoever feeds has to be in its zone.
function feed(me, portal) {
  if (me.score < 1 || dist(portal.p, me.p) > ZONE) return false;
  me.score -= 1;
  const was = levelOf(portal.fed);
  portal.fed += 1;
  const level = levelOf(portal.fed), cap = LEVELS[level - 1].cap;
  portal.energy = Math.min(cap, portal.energy + FEED_GAIN);
  give(me, 1);
  io.emit('portal:fed', { id: portal.id, energy: portal.energy, fed: portal.fed, level, cap, grew: level > was, by: me.id });
  io.emit('score', { id: me.id, score: me.score });
  return true;
}

// Who can be hit right now: in the sky, not shielded, and outside every topic.
const exposed = (p, now) => !(p.downUntil > now) && !(p.shieldUntil > now) && !zoneOf(p.p);

function dash(me, now) {
  if (me.downUntil > now || me.dashReady > now || zoneOf(me.p)) return false;
  me.dashUntil = now + DASH_MS;
  me.dashReady = now + (me.bot ? DASH_EVERY * 1.8 : DASH_EVERY);
  io.emit('dash', { id: me.id });
  return true;
}

// Scatter one comet. Its sparks are not made up: that many of the sky's own sparks are
// moved to where it was, so the number of sparks in the world never changes.
function scatter(victim, by, now) {
  const lost = victim.score;
  const at = victim.p.slice();
  victim.score = 0;
  victim.downUntil = now + DOWN_MS;
  victim.dashUntil = 0;
  by.hits = (by.hits || 0) + 1;
  const drop = Math.min(lost, DROP_MAX);
  const pool = sparks.map((s, i) => i).sort((a, b) => dist(sparks[b].p, at) - dist(sparks[a].p, at));   // the farthest ones are taken
  for (let n = 0; n < drop; n++) {
    const s = sparks[pool[n]];
    const dir = [rand(1), rand(1), rand(1)], len = Math.hypot(dir[0], dir[1], dir[2]) || 1, r = 4 + Math.random() * 5;
    s.p = at.map((v, k) => v + dir[k] / len * r);
    s.to = s.p.slice();
    s.heldUntil = now + 500;                 // a beat before anyone can take them, so the burst is seen
  }
  io.emit('scattered', { id: victim.id, by: by.id, byName: by.name, name: victim.name, lost, p: at, streak: by.hits });
  io.emit('score', { id: victim.id, score: 0 });
}

io.on('connection', (socket) => {
  socket.on('join', (who) => {
    const me = { id: socket.id, name: clean(who && who.name, 18) || 'comet', hue: Math.floor(Math.random() * 360), p: [rand(6), rand(3), rand(6)], score: 0 };
    players[socket.id] = me;
    socket.emit('welcome', {
      me: publicPlayer(me), players: Object.values(players).map(publicPlayer), portals: portals.map(publicPortal), sparks: sparks.map((s) => s.p),
      rules: { dashEvery: DASH_EVERY, dashMs: DASH_MS, downMs: DOWN_MS, zone: ZONE, cost: PORTAL_COST, feed: FEED_GAIN, spacing: PORTAL_SPACING, world: WORLD },
    });
    socket.broadcast.emit('player:joined', publicPlayer(me));
  });

  socket.on('move', (p) => {
    const me = players[socket.id];
    if (!me || !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return;
    if (me.downUntil > Date.now()) return;       // a scattered comet is nowhere until it is put back
    me.p = p;
  });

  socket.on('dash', (reply) => {
    const me = players[socket.id];
    const ok = !!me && dash(me, Date.now());
    if (typeof reply === 'function') reply({ ok });
  });

  // At most two whispers a second from anyone, and only inside a topic's zone.
  let lastWhisper = 0;
  socket.on('whisper', (text, reply) => {
    const me = players[socket.id];
    const answer = typeof reply === 'function' ? reply : () => {};
    const line = clean(text, 140);
    if (!me || !line || Date.now() - lastWhisper < 500) return answer({ error: 'Too fast.' });
    lastWhisper = Date.now();
    answer(whisper(me, line) ? { ok: true } : { error: 'You can only talk inside a topic.' });
  });

  // Opening a topic costs sparks, and needs room around it.
  socket.on('portal:create', (data, reply) => {
    const me = players[socket.id];
    const answer = typeof reply === 'function' ? reply : () => {};
    if (!me) return answer({ error: 'Not in the world.' });
    if (me.score < PORTAL_COST) return answer({ error: `A topic costs ${PORTAL_COST} sparks.` });
    if (portals.some((p) => dist(p.p, me.p) < PORTAL_SPACING)) return answer({ error: 'Too close to another topic. Fly further out.' });
    const name = clean(data && data.name, 60);
    if (!name) return answer({ error: 'A topic needs a name.' });
    const image = data && typeof data.image === 'string' && data.image.startsWith('data:image/') && data.image.length < IMAGE_LIMIT * 1.4 ? data.image : '';
    me.score -= PORTAL_COST;
    give(me, PORTAL_COST);
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
    answer(feed(me, portal) ? { ok: true } : { error: 'Too far from it.' });
  });

  socket.on('disconnect', () => {
    if (!players[socket.id]) return;
    delete players[socket.id];
    io.emit('player:left', socket.id);
  });
});

// ---- Simulated comets (BOTS=n, 14 by default, 0 for none).
const BOTS = Number(process.env.BOTS === undefined ? 14 : process.env.BOTS);
if (BOTS > 0) {
  sims = require('./sims')({
    count: BOTS, players, portals, sparks, io,
    dist, somewhere, zoneOf, exposed, dash, whisper, plantPortal, feed, give,
    rules: { ZONE, PORTAL_COST, PORTAL_SPACING, WORLD },
  });
}

// ---- The world's clock.
// Sparks drift toward a point and pick a new one when they arrive. A comet that touches
// one collects it, and the spark starts again somewhere else.
// The clock asks for 20 steps a second and takes whatever the machine's timer gives it
// (about 16 on Windows): every step moves things by the time that really passed, so the
// world runs at the same speed either way. Every step is sent to everyone, in order.
let lastStep = Date.now(), stepCost = 0;
setInterval(() => {
  const began = process.hrtime.bigint();
  const now = Date.now();
  const STEP = Math.min(0.15, (now - lastStep) / 1000);
  lastStep = now;
  if (sims) sims.steer(STEP, now);
  const everyone = Object.values(players);

  // Dashes that land. Two comets dashing into each other bounce off and nobody loses anything.
  for (const a of everyone) {
    if (!(a.dashUntil > now) || a.downUntil > now || zoneOf(a.p)) continue;
    for (const b of everyone) {
      if (b === a || !exposed(b, now) || dist(a.p, b.p) > HIT_RADIUS) continue;
      if (b.dashUntil > now) { a.dashUntil = b.dashUntil = 0; io.emit('clash', { a: a.id, b: b.id, p: a.p }); }
      else scatter(b, a, now);
      break;
    }
  }
  // Scattered comets come back somewhere else, shielded for a moment.
  for (const p of everyone) {
    if (p.downUntil && p.downUntil <= now) {
      p.downUntil = 0;
      p.shieldUntil = now + SHIELD_MS;
      p.p = somewhere();
      io.emit('respawn', { id: p.id, p: p.p, shield: SHIELD_MS });
    }
  }

  const list = everyone.filter((p) => !(p.downUntil > now));     // only comets in the sky pull and collect
  sparks.forEach((spark, index) => {
    if (spark.heldUntil > now) return;
    // A comet pulls the sparks around it: inside MAGNET a spark leaves its drift and falls
    // toward the nearest comet, faster the closer it is.
    let pull = null, pullD = MAGNET;
    for (const player of list) { const away = dist(spark.p, player.p); if (away < pullD) { pullD = away; pull = player; } }
    const d = dist(spark.p, spark.to);
    if (pull) {
      const speed = 6 + (1 - pullD / MAGNET) * 22;      // a drift at the edge, quick once it is close
      for (let k = 0; k < 3; k++) spark.p[k] += (pull.p[k] - spark.p[k]) / (pullD || 1) * Math.min(pullD, speed * STEP);
    } else if (d < 0.5) spark.to = somewhere();
    else for (let k = 0; k < 3; k++) spark.p[k] += (spark.to[k] - spark.p[k]) / d * spark.speed * STEP;
    for (const player of list) {
      if (dist(spark.p, player.p) < EAT_RADIUS) {
        player.score += 1;
        spark.p = somewhere(); spark.to = somewhere();
        io.emit('spark:eaten', { index, by: player.id, score: player.score });
        break;
      }
    }
  });
  if (everyone.some((p) => !p.bot)) {
    io.emit('tick', {
      players: list.map((p) => [p.id, +p.p[0].toFixed(2), +p.p[1].toFixed(2), +p.p[2].toFixed(2)]),
      sparks: sparks.map((s) => [+s.p[0].toFixed(1), +s.p[1].toFixed(1), +s.p[2].toFixed(1)]),
    });
  }
  // A running average of what one step costs, shown on /health.
  stepCost += (Number(process.hrtime.bigint() - began) / 1e6 - stepCost) * 0.05;
}, 50);

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
