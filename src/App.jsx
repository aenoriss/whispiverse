import React, { useEffect, useRef, useState } from 'react'
import { World } from './world.js'
import { Voice } from './voice.js'

// The panels around the world: the way in, the sparks you hold, which topic you are in,
// a topic's card, the form for opening one, the map, and what is being said. The world
// itself is in world.js.

const RADAR_RANGE = 70
const MAP_SPAN = 112                              // world units from the centre to the map's edge
const FULL = 90                                   // seconds at which a topic's gauge reads as full
const LOW = 30                                    // below this a topic is running out
const ROSE = '#ffa6b4', GOLD = '#ffc86b', CREAM = '#fff3dc'
const DISPLAY = "'Grandstander', 'Nunito', sans-serif"

// A picked image is shrunk in the browser before it is sent, so a topic's picture is a
// few tens of kilobytes whatever the file was.
function shrink(file, max = 480) {
  return new Promise((done) => {
    const img = new Image()
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      done(c.toDataURL('image/jpeg', 0.8))
      URL.revokeObjectURL(img.src)
    }
    img.onerror = () => done('')
    img.src = URL.createObjectURL(file)
  })
}

// The four-pointed star everything here is built from.
const STAR = 'M0-11C1.4-3.2 3.2-1.4 11 0 3.2 1.4 1.4 3.2 0 11-1.4 3.2-3.2 1.4-11 0-3.2-1.4-1.4-3.2 0-11Z'
const Star = ({ className = '' }) => <svg className={'star ' + className} viewBox="-12 -12 24 24" aria-hidden="true"><path d={STAR} /></svg>

// The same star on a canvas.
function sparkle(g, x, y, s) {
  g.beginPath()
  g.moveTo(x, y - s)
  g.quadraticCurveTo(x + s * 0.16, y - s * 0.16, x + s, y)
  g.quadraticCurveTo(x + s * 0.16, y + s * 0.16, x, y + s)
  g.quadraticCurveTo(x - s * 0.16, y + s * 0.16, x - s, y)
  g.quadraticCurveTo(x - s * 0.16, y - s * 0.16, x, y - s)
  g.fill()
}

// How long a topic has left, as a row of stars that go out one by one: nine stars, ten
// seconds each. Under thirty seconds the ones still lit turn to embers.
function Stars({ energy, small }) {
  const lit = Math.min(9, Math.ceil(energy / (FULL / 9)))
  return (
    <span className={'stars' + (small ? ' small' : '') + (energy < LOW ? ' low' : '')} title={`${energy} seconds left`}>
      {Array.from({ length: 9 }, (_, i) => <Star key={i} className={i < lit ? 'lit' : ''} />)}
    </span>
  )
}

// The count of sparks, drawn the way the comet itself wears them: a star with rings round
// it, one spark a dot, three to a ring. A complete ring is one topic's worth and is lit.
function Orbits({ score, cost }) {
  return (
    <svg className="orbits" viewBox="-40 -40 80 80" aria-hidden="true">
      {[0, 1, 2, 3].map((k) => {
        const held = Math.max(0, Math.min(cost, score - k * cost)), r = 13 + k * 8
        return (
          <g key={k} transform={`rotate(${k * 40 - 20})`}>
            <ellipse rx={r} ry={r * 0.42} className={held === cost ? 'ring full' : held ? 'ring some' : 'ring'} />
            {Array.from({ length: held }, (_, j) => {
              const a = (j / cost) * Math.PI * 2 + k
              return <circle key={j} cx={Math.cos(a) * r} cy={Math.sin(a) * r * 0.42} r="2.8" className="dot" />
            })}
          </g>
        )
      })}
      <path d={STAR} className="core" transform={`scale(${0.75 + Math.min(0.5, score * 0.04)})`} />
    </svg>
  )
}

// The radar: what is around you, with ahead at the top. Sparks are gold stars, comets are
// cream dots, and every topic is shown with its zone at true size, so you can see the edge
// of where you can talk before you reach it.
function drawRadar(c, data) {
  const g = c.getContext('2d'), R = c.width / 2
  g.clearRect(0, 0, c.width, c.height)
  g.save()
  g.beginPath(); g.arc(R, R, R - 2, 0, Math.PI * 2); g.clip()
  data.portals.forEach(([x, y]) => {
    g.fillStyle = 'rgba(255,166,180,0.2)'
    g.beginPath(); g.arc(R + x * R, R + y * R, data.zone * R, 0, Math.PI * 2); g.fill()
    g.strokeStyle = ROSE; g.lineWidth = 2.5; g.setLineDash([3, 7]); g.lineCap = 'round'
    g.stroke(); g.setLineDash([])
    g.fillStyle = ROSE
    g.beginPath(); g.arc(R + x * R, R + y * R, 7, 0, Math.PI * 2); g.fill()
  })
  g.fillStyle = GOLD
  data.sparks.forEach(([x, y, up]) => sparkle(g, R + x * R, R + y * R, Math.max(5, Math.min(11, 7.5 + up * 0.1))))
  g.fillStyle = CREAM
  data.comets.forEach(([x, y]) => { g.beginPath(); g.arc(R + x * R, R + y * R, 4.5, 0, Math.PI * 2); g.fill() })
  g.restore()
  if (data.guide) {
    const x = R + data.guide[0] * (R - 12), y = R + data.guide[1] * (R - 12)
    g.strokeStyle = CREAM; g.lineWidth = 3
    g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.stroke()
  }
  // You, in the middle.
  g.fillStyle = CREAM
  sparkle(g, R, R, 15)
}

// The map: the whole sky from above, north up. Every open topic with its name, its zone at
// true size, how full it is and the comets gathered in it, and where you are and are looking.
function drawMap(c, snap, waypoint) {
  const g = c.getContext('2d'), R = c.width / 2
  const X = (x) => R + (x / MAP_SPAN) * R, Y = (z) => R + (z / MAP_SPAN) * R
  const zone = (snap.zone / MAP_SPAN) * R
  g.clearRect(0, 0, c.width, c.height)
  g.fillStyle = 'rgba(255,200,107,0.75)'
  snap.sparks.forEach(([x, z]) => sparkle(g, X(x), Y(z), 5))

  const me = snap.comets.find((p) => p.me)
  const target = snap.topics.find((t) => t.id === waypoint)
  if (me && target) {
    g.strokeStyle = CREAM; g.lineWidth = 3; g.setLineDash([2, 12]); g.lineCap = 'round'
    g.beginPath(); g.moveTo(X(me.x), Y(me.z)); g.lineTo(X(target.x), Y(target.z)); g.stroke()
    g.setLineDash([])
  }

  g.textAlign = 'center'
  const taken = []                                // label boxes already drawn, so names do not land on each other
  const free = (box) => !taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])
  snap.topics.forEach((t) => {
    const x = X(t.x), y = Y(t.z), full = Math.min(1, t.energy / FULL)
    // The zone: a warm pool, with a dotted edge.
    const pool = g.createRadialGradient(x, y, 0, x, y, zone)
    pool.addColorStop(0, 'rgba(255,166,180,0.42)'); pool.addColorStop(1, 'rgba(255,166,180,0.1)')
    g.fillStyle = pool
    g.beginPath(); g.arc(x, y, zone, 0, Math.PI * 2); g.fill()
    g.strokeStyle = 'rgba(255,166,180,0.8)'; g.lineWidth = 2.5; g.setLineDash([2, 9]); g.lineCap = 'round'
    g.stroke(); g.setLineDash([])
    // The portal: a cream heart inside a ring that empties as the topic runs down.
    g.strokeStyle = t.energy < LOW ? '#ff8052' : CREAM; g.lineWidth = 6
    g.beginPath(); g.arc(x, y, 17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * full); g.stroke()
    g.fillStyle = CREAM
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill()
    g.font = `600 25px ${DISPLAY}`
    const text = t.name.length > 30 ? t.name.slice(0, 29) + '…' : t.name
    const w = g.measureText(text).width
    const lx = Math.max(w / 2 + 8, Math.min(c.width - w / 2 - 8, x))
    const ly = [y - zone - 14, y + zone + 32, y - zone - 46].find((at) => free([lx - w / 2, at - 24, lx + w / 2, at + 6])) || y - zone - 14
    taken.push([lx - w / 2 - 6, ly - 26, lx + w / 2 + 6, ly + 8])
    g.fillStyle = CREAM
    g.fillText(text, lx, ly)
  })

  // Comets: a dot each. Names only for people, since simulated ones are just traffic.
  snap.comets.forEach((p) => {
    if (p.me) return
    g.fillStyle = p.bot ? 'rgba(255,243,220,0.8)' : '#ffffff'
    g.beginPath(); g.arc(X(p.x), Y(p.z), p.bot ? 4.5 : 6.5, 0, Math.PI * 2); g.fill()
    if (p.bot) return
    g.font = `600 19px ${DISPLAY}`
    g.fillText(p.name, X(p.x), Y(p.z) + 26)
  })

  if (me) {
    g.save()
    g.translate(X(me.x), Y(me.z)); g.rotate(snap.heading)
    g.fillStyle = GOLD
    g.beginPath(); g.moveTo(0, -30); g.lineTo(7, -12); g.lineTo(-7, -12); g.closePath(); g.fill()     // the way you are looking
    sparkle(g, 0, 0, 17)
    g.restore()
  }
}

export default function App() {
  const canvas = useRef(null)
  const radar = useRef(null)
  const mapCanvas = useRef(null)
  const whisperInput = useRef(null)
  const world = useRef(null)
  const voice = useRef(null)
  const state = useRef({})                       // the latest values, for handlers set up once
  const [stage, setStage] = useState('intro')    // intro, joining, world
  const [name, setName] = useState('')
  const [score, setScore] = useState(0)
  const [census, setCensus] = useState({ count: 1, sims: 0 })
  const [near, setNear] = useState(null)         // the topic whose zone you are in
  const [rules, setRules] = useState({ cost: 3, feed: 20 })
  const [form, setForm] = useState(null)         // null, or { name, description, image }
  const [talking, setTalking] = useState(false)
  const [note, setNote] = useState('')
  const [offline, setOffline] = useState(false)
  const [bump, setBump] = useState(0)
  const [lines, setLines] = useState([])         // what was said lately in your topic
  const [draft, setDraft] = useState(null)       // null, or what is being typed
  const [mapOpen, setMapOpen] = useState(false)
  const [topics, setTopics] = useState([])
  const [way, setWay] = useState(null)           // the topic being flown to: { id, name, away }

  state.current = { score, near, rules, form, stage, draft, mapOpen, way }

  const say = (text) => { setNote(text); clearTimeout(say.timer); say.timer = setTimeout(() => setNote(''), 3200) }

  useEffect(() => {
    const w = world.current = new World(canvas.current, (change) => {
      if ('offline' in change) setOffline(change.offline)
      if (change.joined) { setStage('world'); setRules(change.rules) }
      if ('score' in change) setScore(change.score)
      if (change.ate) setBump((n) => n + 1)
      if (change.census) setCensus(change.census)
      if ('near' in change) {
        // Crossing a zone's edge is said out loud, both ways.
        const was = state.current.near
        if (change.near && (!was || was.id !== change.near.id)) say(`You are in “${change.near.name}”. You can talk here.`)
        if (!change.near && was) { say(`You left “${was.name}”.`); setDraft(null); setLines([]) }
        setNear(change.near)
      }
      if (change.arrived && !change.arrived.bot) { say(`${change.arrived.name} arrived`); if (voice.current) voice.current.call(change.arrived.id, w.me.id) }
      if (change.left && voice.current) voice.current.hangUp(change.left)
      if (change.heard) {
        const line = { ...change.heard, key: Math.random() }
        setLines((all) => all.concat(line).slice(-4))
        setTimeout(() => setLines((all) => all.filter((l) => l !== line)), 9000)
      }
      if (change.act) act()
    })
    window.whispiverse = w                       // a handle for poking at the world from the console

    // Keys that belong to the panels. Flying keys are the world's own.
    const onKey = (e) => {
      const s = state.current
      if (s.stage !== 'world') return
      const typing = e.target && /INPUT|TEXTAREA/.test(e.target.tagName)
      if (e.code === 'Escape') { setDraft(null); setMapOpen(false); setForm(null); return }
      if (typing) return
      if (e.code === 'Enter' && !s.form) { e.preventDefault(); startTalking() }
      if (e.code === 'KeyM' && !s.form) setMapOpen((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); w.dispose(); if (voice.current) voice.current.stop() }
  }, [])

  // The radar, and the line that says how far the topic you are heading to is.
  useEffect(() => {
    if (stage !== 'world') return
    let stop = false, last = 0, slow = 0
    const draw = (now) => {
      if (stop) return
      requestAnimationFrame(draw)
      if (now - last < 66 || !radar.current) return
      last = now
      const data = world.current.radar(RADAR_RANGE)
      if (data) drawRadar(radar.current, data)
      if (now - slow > 250) {
        slow = now
        const info = world.current.waypointInfo()
        const had = state.current.way
        if (!info) { if (had) setWay(null) }
        else if (info.away < world.current.zone - 2) { world.current.setWaypoint(null); setWay(null) }
        else if (!had || had.away !== info.away) setWay({ id: world.current.waypoint, name: info.name, away: info.away })
      }
    }
    requestAnimationFrame(draw)
    return () => { stop = true }
  }, [stage])

  // The map redraws five times a second while it is open.
  useEffect(() => {
    if (!mapOpen) return
    const draw = () => {
      const snap = world.current.snapshot()
      if (!snap) return
      setTopics(snap.topics.slice().sort((a, b) => a.away - b.away))
      if (mapCanvas.current) drawMap(mapCanvas.current, snap, world.current.waypoint)
    }
    draw()
    const timer = setInterval(draw, 200)
    return () => clearInterval(timer)
  }, [mapOpen])

  useEffect(() => { if (draft === '' && whisperInput.current) whisperInput.current.focus() }, [draft === null])

  // Talking only works inside a topic. Outside one, say so and point at the nearest.
  function startTalking() {
    const s = state.current
    if (s.near) { setMapOpen(false); setDraft(''); return }
    const nearest = world.current.nearestTopic()
    if (!nearest) return say('Nothing to talk in yet. Collect 3 sparks and press Space to open a topic.')
    world.current.setWaypoint(nearest.id)
    setWay(nearest)
    say(`You can only talk inside a topic. Follow the stars to “${nearest.name}”.`)
  }

  // Space: feed the topic you are in, or open one where you are.
  async function act() {
    const s = state.current
    if (s.stage !== 'world' || s.form || s.mapOpen) return
    if (s.near) {
      if (s.score < 1) return say('No sparks to feed it with.')
      const answer = await world.current.feedPortal(s.near.id)
      if (answer.error) say(answer.error)
      return
    }
    if (s.score < s.rules.cost) return say(`A topic costs ${s.rules.cost} sparks. You have ${s.score}.`)
    setForm({ name: '', description: '', image: '' })
  }

  async function plant(e) {
    e.preventDefault()
    const answer = await world.current.createPortal(form)
    if (answer.error) return say(answer.error)
    setForm(null)
  }

  async function sendWhisper(e) {
    e.preventDefault()
    const text = draft && draft.trim()
    setDraft(null)
    if (!text) return
    const answer = await world.current.say(text)
    if (answer && answer.error) say(answer.error)
  }

  function headTo(topic) {
    world.current.setWaypoint(topic.id)
    setWay({ id: topic.id, name: topic.name, away: topic.away })
    setMapOpen(false)
  }

  async function toggleVoice() {
    if (voice.current) { voice.current.stop(); voice.current = null; world.current.voice = null; setTalking(false); return }
    try {
      const v = voice.current = await Voice.start(world.current.me.id)
      world.current.voice = v
      for (const [id, p] of world.current.players) if (id !== world.current.me.id && !p.bot) v.call(id, world.current.me.id)
      setTalking(true)
      say('Your voice is on. It carries inside the topic you are in.')
    } catch (err) {
      say('The microphone was not allowed.')
    }
  }

  function enter(e) {
    e.preventDefault()
    setStage('joining')
    world.current.join(name.trim() || 'comet')
  }

  const afford = Math.floor(score / rules.cost)
  const Key = ({ k, children }) => <span className="key"><kbd>{k}</kbd>{children}</span>

  return (
    <>
      <canvas ref={canvas} className="world" />

      {stage !== 'world' && (
        <form className="intro" onSubmit={enter}>
          <div className="intro-inner">
            <p className="kicker"><Star /> a forum you fly through</p>
            <h1>Whispiverse</h1>
            <p className="lede">You are a comet in a shared sky. Each glowing bubble is a topic someone opened, and inside it is the only place you can talk. Gather sparks, open your own, and feed the ones worth keeping. A topic nobody feeds goes out.</p>
            <label>
              <span>What should we call you?</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={18} placeholder="comet" autoFocus />
            </label>
            <button className="big" disabled={stage === 'joining'}><Star />{stage === 'joining' ? (offline ? 'No server yet, trying again' : 'Drifting in') : 'Fly in'}</button>
          </div>
        </form>
      )}

      {stage === 'world' && (
        <>
          <header className="hud">
            <p className="brand">Whispiverse</p>
            <p className="soft">{census.count === 1 ? 'You are alone here' : `${census.count} comets here`}{census.sims > 0 && `, ${census.sims} simulated`}</p>
          </header>

          {/* Where you are, and whether you can talk. Always on screen. */}
          <div className={'where' + (near ? ' in' : '')}>
            {near ? (
              <><Star /><p><b>{near.name}</b><span>You are inside this topic. You can talk here.</span></p></>
            ) : way ? (
              <><Star /><p><b>{way.name}</b><span>{way.away} away. Follow the stars.</span></p>
                <button className="tiny" onClick={() => { world.current.setWaypoint(null); setWay(null) }}>Stop</button></>
            ) : (
              <p><b>Open sky</b><span>Fly into a topic's glow to talk.</span></p>
            )}
          </div>

          <div className="counts">
            <div className="sparks">
              <Orbits score={score} cost={rules.cost} key={bump} />
              <p><b>{score}</b><span>{score === 1 ? 'spark' : 'sparks'}</span>
                <em className={afford ? 'ready' : ''}>{afford ? `enough for ${afford === 1 ? 'a topic' : afford + ' topics'}` : `${rules.cost - score} more for a topic`}</em></p>
            </div>
            <button className={'round' + (mapOpen ? ' on' : '')} onClick={() => setMapOpen(!mapOpen)}>Map</button>
            <button className={'round' + (talking ? ' on' : '')} onClick={toggleVoice}>{talking ? 'Voice on' : 'Voice off'}</button>
          </div>

          {near && !form && !mapOpen && (
            <aside className="card">
              {near.image ? <img src={near.image} alt="" /> : null}
              <p className="soft">opened by {near.owner}</p>
              <h2>{near.name}</h2>
              {near.description && <p className="about">{near.description}</p>}
              <p className="time"><Stars energy={near.energy} /><span><b>{near.energy}</b> s until it goes out</span></p>
              {near.thread && near.thread.length > 0 && (
                <ul className="thread">
                  {near.thread.slice(-4).map((l, i) => <li key={i}><b>{l.name}</b>{l.text}</li>)}
                </ul>
              )}
              <p className="keys"><Key k="Space">feed it a spark</Key><Key k="Enter">say something</Key></p>
            </aside>
          )}

          {form && (
            <form className="card plant" onSubmit={plant}>
              <p className="soft">costs {rules.cost} sparks</p>
              <h2>Open a topic here</h2>
              <label><span>What is the topic?</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required autoFocus /></label>
              <label><span>A line about it</span><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={240} rows={2} /></label>
              <label><span>A picture, if you like</span><input type="file" accept="image/png, image/jpeg, image/gif, image/webp" onChange={async (e) => setForm({ ...form, image: e.target.files[0] ? await shrink(e.target.files[0]) : '' })} /></label>
              {form.image && <img src={form.image} alt="" />}
              <div className="row"><button className="big"><Star />Open it</button><button type="button" className="round" onClick={() => setForm(null)}>Not now</button></div>
            </form>
          )}

          {mapOpen && (
            <section className="map">
              <canvas ref={mapCanvas} width="900" height="900" />
              <div className="topics">
                <p className="soft">{topics.length === 0 ? 'no topics open' : topics.length === 1 ? '1 topic open' : `${topics.length} topics open`}</p>
                <h2>Where the talk is</h2>
                {topics.length === 0 && <p className="about">Gather {rules.cost} sparks and press Space to open the first one.</p>}
                <ul>
                  {topics.map((t) => (
                    <li key={t.id}>
                      <button className={'topic' + (way && way.id === t.id ? ' going' : '')} onClick={() => headTo(t)}>
                        <b>{t.name}</b>
                        <Stars energy={t.energy} small />
                        <span>{t.here === 0 ? 'nobody there' : t.here === 1 ? '1 comet talking' : `${t.here} comets talking`}, {t.away} away</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="keys">Pick one and follow the stars to it.</p>
              </div>
            </section>
          )}

          <div className="radar">
            <canvas ref={radar} width="340" height="340" />
          </div>

          <div className="heard">
            {lines.map((l) => <p key={l.key} className={l.mine ? 'mine' : ''}><b>{l.name}</b>{l.text}</p>)}
          </div>

          {draft !== null && (
            <form className="whisper" onSubmit={sendWhisper}>
              <input ref={whisperInput} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={140} placeholder={near ? `Say something in “${near.name}”` : ''} onBlur={() => setDraft(null)} />
            </form>
          )}

          <p className="keys hint">
            <Key k="W">fly</Key><Key k="drag">steer</Key><Key k="Shift">boost</Key><Key k="S">brake</Key>
            <Key k="Space">{near ? 'feed' : 'open a topic'}</Key><Key k="M">map</Key>{near && <Key k="Enter">talk</Key>}
          </p>
          {note && <p className="note"><Star />{note}</p>}
        </>
      )}
    </>
  )
}
