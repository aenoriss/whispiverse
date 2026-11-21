// The simulated comets. An empty sky is a poor forum and a dull game, so the server flies
// some comets of its own. They are marked as simulated to everyone, and they play by the
// same rules as a person: the same sparks, the same costs, the same dash, the same zones.
//
// Each one has a role, which is what it wants, and every third of a second it looks at
// where it is and picks what to do about it:
//
// (they start out spread across the roles below)
//   host      opens a topic, stays in it, talks, and goes out for sparks when it runs low
//   wanderer  gathers a little, drops in on topics, moves on
//   keeper    looks for the topic nearest to closing and feeds it
//   hunter    goes after comets carrying sparks in open sky, then banks what it took
//   guardian  goes after hunters that are after someone
//
// A role is not fixed. Every several seconds a comet looks at its situation and may become
// something else: one with a topic of its own is a host; one with a pocketful and nowhere
// to put it becomes a host or a keeper; a poor one beside a rich one may turn hunter if it
// is fierce enough; one that sees a hunt nearby may turn guardian if it has the nerve; one
// near a topic about to close becomes a keeper. So the same comet can greet you in a topic
// and come after you ten minutes later when you fly past it loaded.
//
// Whatever the role, a comet that is being hunted and has something to lose either runs
// for the nearest topic or, if it has the nerve and a dash ready, turns and dashes back.
//
// They move by steering: a wanted velocity, eased into, with a little drift, so they curve
// and overshoot the way a flown comet does instead of sliding along straight lines.
module.exports = function createSims(world) {
  const { players, portals, sparks, io, dist, somewhere, zoneOf, exposed, dash, whisper, plantPortal, feed } = world;
  const { ZONE, PORTAL_COST, PORTAL_SPACING } = world.rules;

  const NAMES = ['halley', 'encke', 'swift', 'tuttle', 'hale', 'bopp', 'lovejoy', 'wild', 'biela', 'faye', 'wolf', 'kopff', 'borrelly', 'tempel', 'holmes', 'finlay'];
  const ROLES = ['host', 'wanderer', 'hunter', 'keeper', 'wanderer', 'guardian', 'host'];
  // Each topic comes with things that can be said in it.
  const TOPICS = [
    ['What are you building this week?', 'Half-finished things welcome.', ['A tiny synth that runs in a tab.', 'Still arguing with my build config.', 'A map of the trees on my street.', 'Nothing yet. I came for ideas.', 'A clock that only shows the tide.', 'Rewriting the thing I wrote last week.']],
    ['Music to work to', 'One record, and why it works for you.', ['Anything without words.', 'Rain sounds, honestly.', 'The same album since March.', 'Film scores, loud.', 'Whatever the last person here said.', 'Silence, then one song on repeat.']],
    ['Show your worst bug', 'The longer it took to find, the better.', ['Off by one. Three days.', 'It only failed on Tuesdays.', 'A timezone, of course.', 'The cache was right. I was wrong.', 'A space at the end of a line.', 'It worked. That was the bug.']],
    ['Is the web still fun?', 'Make the case either way.', ['It is when you make small things.', 'View source used to teach you everything.', 'Yes. This is a web page.', 'Ask me after the next rewrite.', 'Fun is a page with one idea.', 'It got heavier, not worse.']],
    ['Small games worth an evening', 'Under two hours, no tutorials.', ['Anything with one good idea.', 'The short ones stay with you.', 'I want a list. Keep going.', 'Co-op on one keyboard.', 'One that ends before I am tired.', 'A walk with a good ending.']],
    ['Things learned the hard way', 'What you would tell yourself a year ago.', ['Write it down the day it happens.', 'Ship the small one first.', 'Sleep before you debug.', 'Ask sooner.', 'The backup you did not test is not one.', 'Nobody reads the long message.']],
    ['Tools you stopped using', 'And what replaced them, if anything.', ['Most of my plugins.', 'A notes app. Now it is one text file.', 'Three task managers in a row.', 'Nothing replaced it. That was the point.', 'The dashboard nobody opened.', 'My own framework. Thankfully.']],
    ['A place you keep going back to', 'Real or not.', ['A bench by a river.', 'The level select screen of an old game.', 'A kitchen that smelled of bread.', 'A train window.', 'The roof, when it is quiet.', 'A page I bookmarked years ago.']],
  ];
  const ANY_TOPIC = ['What is this one about?', 'Good topic.', 'I will stay for this.', 'Tell us how it started.', 'Feeding it so it lasts.'];
  const GREETS = [(n) => `Hi ${n}.`, (n) => `Welcome in, ${n}.`, (n) => `${n}, good timing.`, (n) => `Room for one more. Hi ${n}.`];
  const REPLIES = ['Good point.', 'Say more about that.', 'Same here, honestly.', 'Ha, yes.', 'I had not thought of it that way.', 'That is a good one.', 'Go on.'];

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const sims = [];
  for (let i = 0; i < world.count; i++) {
    const id = 'sim-' + i, role = ROLES[i % ROLES.length];
    players[id] = { id, name: NAMES[i % NAMES.length], hue: (i * 83) % 360, p: somewhere(), score: 0, bot: true, role };
    sims.push({
      me: players[id], role, v: [0, 0, 0], mode: 'gather', thinkAt: 0, until: 0,
      topic: null, own: null, prey: null, foe: null, spark: null, spot: null, windup: 0, lunge: null, talkAt: 0,
      ring: 6 + Math.random() * 7, pace: (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.3), turn: 0,
      top: 8 + Math.random() * 3,              // cruising speed
      nerve: 0.15 + Math.random() * 0.5,       // how likely it is to turn and fight when hunted
      fierce: ((i * 5) % world.count) / world.count,   // how readily it turns hunter, spread evenly so a few always will
      roleAt: 8000 + Math.random() * 10000,    // when it next reconsiders what it is (ms on the server's clock)
    });
  }

  // Four topics are already open when the server starts, spread through the whole volume,
  // each one a host's own.
  const hosts = sims.filter((s) => s.role === 'host');
  [[-14, 12, -32], [54, -24, -46], [-62, 28, 20], [24, -30, 60]].forEach((at, i) => {
    const owner = hosts[i % hosts.length] || sims[i % sims.length];
    const made = plantPortal(owner.me.name, at, TOPICS[i][0], TOPICS[i][1]);
    made.lines = TOPICS[i][2];
    made.energy = 120 - i * 20;
    if (!owner.own) owner.own = made;
  });

  // Everyone is told who a comet is after, so the one being hunted can see it coming.
  function setPrey(s, prey) {
    if (s.prey === prey) return;
    s.prey = prey;
    io.emit('hunt', { by: s.me.id, target: prey ? prey.id : null });
  }

  // Who is after this comet right now: a hunter that has picked it, or a person dashing close by.
  function threatTo(s, now) {
    let worst = null;
    for (const h of sims) {
      if (h.prey !== s.me || h.me.downUntil > now) continue;
      const d = dist(h.me.p, s.me.p);
      if (d < 34 && (!worst || d < worst.d)) worst = { who: h.me, d };
    }
    for (const p of Object.values(players)) {
      if (p.bot || !(p.dashUntil > now)) continue;
      const d = dist(p.p, s.me.p);
      if (d < 16 && (!worst || d < worst.d)) worst = { who: p, d };
    }
    return worst;
  }

  const nearestTopic = (p) => portals.slice().sort((a, b) => dist(a.p, p) - dist(b.p, p))[0] || null;
  const go = (s, mode, set) => { s.mode = mode; s.windup = 0; Object.assign(s, set); };

  // ---- Becoming
  // What this comet should be, given where it is and what it holds. At most three hunters
  // at a time, so open sky is risky and not hopeless.
  const started = Date.now();
  function reassess(s, now) {
    const me = s.me;
    s.roleAt = now - started + 6000 + Math.random() * 8000;
    const near = (p, r) => dist(p, me.p) < r;
    const hunters = sims.filter((h) => h.role === 'hunter' && h !== s).length;
    let role = 'wanderer';
    if (s.own) role = 'host';
    else if (sims.some((h) => h.role === 'hunter' && h.prey && h !== s && near(h.me.p, 60)) && s.nerve > 0.4) role = 'guardian';
    // The fiercest hunt whenever they are not loaded themselves. The rest only turn to it
    // when someone richer than them is close and in the open.
    else if (hunters < 3 && me.score < 6 && (s.fierce > 0.8 || (s.fierce > 0.4 && Object.values(players).some((p) => p !== me && p.score >= me.score + 3 && exposed(p, now) && near(p.p, 50))))) role = 'hunter';
    else if (portals.some((t) => t.energy < 35 && near(t.p, 70))) role = 'keeper';
    else if (me.score >= PORTAL_COST && portals.length < 7 && !portals.some((t) => near(t.p, PORTAL_SPACING))) role = 'host';
    if (role === s.role) return;
    s.role = me.role = role;
    if (role !== 'hunter' && role !== 'guardian') setPrey(s, null);
    io.emit('role', { id: me.id, role });
  }

  // ---- Deciding
  function think(s, now) {
    const me = s.me;
    if (s.topic && !portals.includes(s.topic)) s.topic = null;
    if (s.own && !portals.includes(s.own)) s.own = null;
    if (now - started >= s.roleAt && !(s.mode === 'linger' && now < s.until) && !(s.mode === 'hunt' && s.windup > 0)) reassess(s, now);

    // In a topic and meaning to stay: stay, and keep it alive while there.
    if (s.mode === 'linger' && s.topic && now < s.until) {
      // Spend what it carries here, a spark at a time, while the topic has room for it.
      if (me.score > 0 && s.topic.energy < 100) feed(me, s.topic);
      return;
    }
    // Being hunted with something to lose: fight or run.
    if (exposed(me, now) && me.score >= 1) {
      const danger = threatTo(s, now);
      if (danger) {
        setPrey(s, null);
        if (danger.d < 12 && !(me.dashReady > now) && Math.random() < s.nerve) return go(s, 'counter', { foe: danger.who });
        const safe = nearestTopic(me.p);
        if (safe) return go(s, 'flee', { topic: safe });
      }
    }

    const lowest = portals.slice().sort((a, b) => a.energy - b.energy)[0];
    const keep = () => {
      if (me.score > 0 && lowest && lowest.energy < 50) return go(s, 'feed', { topic: lowest });
      if (me.score < 2 || !portals.length) return go(s, 'gather', {});
      return go(s, 'visit', { topic: pick(portals) });
    };

    if (s.role === 'hunter') {
      // Carrying a good haul is a risk for a hunter too: bank it in whichever topic needs it most.
      if (me.score >= 6 && lowest) { setPrey(s, null); return go(s, 'feed', { topic: lowest }); }
      const still = s.prey && players[s.prey.id] === s.prey && exposed(s.prey, now) && s.prey.score >= 2 && dist(s.prey.p, me.p) < 60;
      const prey = still ? s.prey : Object.values(players)
        .filter((p) => p !== me && p.score >= 3 && exposed(p, now) && dist(p.p, me.p) < 44)
        .sort((a, b) => (b.score - dist(b.p, me.p) * 0.1) - (a.score - dist(a.p, me.p) * 0.1))[0] || null;
      setPrey(s, prey);
      return prey ? go(s, 'hunt', {}) : go(s, 'gather', {});
    }
    if (s.role === 'guardian') {
      // A hunter that is after someone, a person before a simulated comet.
      const foe = sims.filter((h) => h.role === 'hunter' && h.prey && exposed(h.me, now) && dist(h.me.p, me.p) < 75)
        .sort((a, b) => (a.prey.bot ? 1 : 0) - (b.prey.bot ? 1 : 0) || dist(a.me.p, me.p) - dist(b.me.p, me.p))[0];
      setPrey(s, foe ? foe.me : null);
      return foe ? go(s, 'hunt', {}) : keep();
    }
    if (s.role === 'keeper') return keep();
    if (s.role === 'host') {
      if (s.own) {
        if (s.own.energy < 45 && me.score === 0) return go(s, 'gather', {});
        return go(s, 'visit', { topic: s.own });
      }
      if (me.score >= PORTAL_COST && portals.length < 7) return go(s, 'open', { spot: null });
      return go(s, 'gather', {});
    }
    // wanderer
    if (portals.length && (me.score >= 2 || Math.random() < 0.3)) return go(s, 'visit', { topic: pick(portals) });
    return go(s, 'gather', {});
  }

  // How long a comet means to stay once it is in a topic.
  const stay = (s) => (s.role === 'host' ? 25 + Math.random() * 30 : s.role === 'hunter' ? 4 + Math.random() * 4 : 9 + Math.random() * 14) * 1000;

  // ---- Moving
  function steer(dt, now) {
    for (const s of sims) {
      const me = s.me;
      if (me.downUntil > now) { s.mode = 'gather'; s.v = [0, 0, 0]; s.topic = null; s.spark = null; s.thinkAt = 0; setPrey(s, null); continue; }
      // Mid-dash: carry straight on, fast.
      if (me.dashUntil > now && s.lunge) { for (let k = 0; k < 3; k++) me.p[k] += s.lunge[k] * 34 * dt; continue; }
      if (now >= s.thinkAt) { think(s, now); s.thinkAt = now + 280 + Math.random() * 300; }

      let goal = null, speed = s.top;
      if (s.mode === 'linger' && s.topic) {
        // Circle inside the zone, slowly, rising and falling a little.
        s.turn += dt * s.pace;
        goal = [s.topic.p[0] + Math.cos(s.turn) * s.ring, s.topic.p[1] + Math.sin(s.turn * 0.7) * 3, s.topic.p[2] + Math.sin(s.turn) * s.ring];
        speed = 4;
      } else if ((s.mode === 'visit' || s.mode === 'feed' || s.mode === 'flee') && s.topic) {
        goal = s.topic.p;
        if (s.mode === 'flee') speed = s.top * 1.7;
        if (dist(goal, me.p) < s.ring + 1) {
          if (s.mode === 'feed') feed(me, s.topic);
          s.turn = Math.atan2(me.p[2] - goal[2], me.p[0] - goal[0]);
          go(s, 'linger', { until: now + (s.mode === 'flee' ? 6000 : stay(s)) });
          continue;
        }
      } else if (s.mode === 'open') {
        // Room is needed round a new topic. If there is none here, head somewhere that has it.
        const clear = (p) => !portals.some((t) => dist(t.p, p) < PORTAL_SPACING);
        if (clear(me.p)) {
          const unused = TOPICS.filter((t) => !portals.some((p) => p.name === t[0]));
          if (unused.length && me.score >= PORTAL_COST) {
            const t = pick(unused);
            me.score -= PORTAL_COST;
            world.give(me, PORTAL_COST);
            const made = plantPortal(me.name, me.p, t[0], t[1]);
            made.lines = t[2];
            io.emit('score', { id: me.id, score: me.score });
            s.turn = 0;
            go(s, 'linger', { topic: made, own: made, until: now + stay(s) });
          } else go(s, 'gather', {});
          continue;
        }
        if (!s.spot || !clear(s.spot)) { s.spot = null; for (let n = 0; n < 12 && !s.spot; n++) { const p = somewhere(); if (clear(p)) s.spot = p; } }
        goal = s.spot || somewhere();
      } else if (s.mode === 'hunt' && s.prey) {
        // Close in, hang for a moment where it can be seen coming, then dash.
        const d = dist(s.prey.p, me.p);
        if (d < 10 && !(me.dashReady > now)) {
          s.windup += dt;
          if (s.windup > 0.75) { s.windup = 0; s.lunge = s.prey.p.map((v, k) => (v - me.p[k]) / (d || 1)); dash(me, now); }
          speed = 2;
        } else s.windup = 0;
        goal = s.prey.p;
        if (speed > 2) speed = s.top * 1.35;
      } else if (s.mode === 'counter' && s.foe) {
        const d = dist(s.foe.p, me.p);
        s.lunge = s.foe.p.map((v, k) => (v - me.p[k]) / (d || 1));
        dash(me, now);
        go(s, 'flee', { topic: nearestTopic(me.p) });
        continue;
      } else {
        // Gathering: one spark at a time, a near one, a host's near its own topic.
        const from = s.own ? s.own.p : me.p;
        if (!s.spark || dist(s.spark.p, me.p) > 70) s.spark = sparks.slice().sort((a, b) => dist(a.p, from) - dist(b.p, from))[Math.floor(Math.random() * 4)];
        goal = s.spark.p;
      }

      // Ease toward the wanted velocity, slowing on arrival, with a little drift.
      const d = dist(goal, me.p) || 1;
      const want = Math.min(speed, d * 1.5);
      for (let k = 0; k < 3; k++) {
        s.v[k] += ((goal[k] - me.p[k]) / d * want - s.v[k]) * Math.min(1, dt * 2.4) + (Math.random() - 0.5) * dt * 1.4;
        me.p[k] += s.v[k] * dt;
      }
    }
    talk(now);
  }

  // ---- Talking
  // One voice at a time in each topic, a few seconds apart, never the line that was just
  // said. A person coming in is greeted, and a person speaking gets an answer.
  function talk(now) {
    for (const t of portals) {
      const here = sims.filter((s) => s.mode === 'linger' && s.topic === t && !(s.me.downUntil > now));
      const people = Object.values(players).filter((p) => !p.bot && dist(p.p, t.p) < ZONE);
      const seen = t.seen || [];
      const fresh = people.find((p) => !seen.includes(p.id));
      t.seen = people.map((p) => p.id);
      if (fresh && here.length) t.greet = { name: fresh.name, at: now + 1200 + Math.random() * 1200 };
      if (!here.length) continue;
      // A full room talks every few seconds. One comet alone says something now and then.
      const pause = () => { t.talkAt = now + (here.length === 1 ? 9000 + Math.random() * 8000 : (2600 + Math.random() * 4200) / Math.min(2, here.length / 2)); };
      if (t.greet && now >= t.greet.at) { whisper(pick(here).me, pick(GREETS)(t.greet.name)); t.greet = null; pause(); continue; }
      if (t.reply && now >= t.reply.at) { whisper(pick(here).me, pick(REPLIES)); t.reply = null; pause(); continue; }
      if (now < (t.talkAt || 0)) continue;
      const free = here.filter((s) => now >= s.talkAt);
      const lately = (t.thread || []).slice(-5).map((l) => l.text);
      const lines = (t.lines || ANY_TOPIC).filter((l) => !lately.includes(l));
      if (!free.length || !lines.length) continue;
      const speaker = pick(free);
      whisper(speaker.me, pick(lines));
      speaker.talkAt = now + 7000 + Math.random() * 9000;
      pause();
    }
  }

  return {
    steer,
    // A person said something in a topic: someone there will answer shortly.
    heard(topic) { topic.reply = { at: Date.now() + 1100 + Math.random() * 1600 }; },
  };
};
