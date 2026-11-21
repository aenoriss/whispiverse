import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { io } from 'socket.io-client'

// The 3D world and everything in it. React only draws the panels around it and is told
// what changed through `onChange`.
//
// The server owns positions, sparks, scores and topics. This file draws what the server
// says, flies the local comet, and sends where it is fifteen times a second.

const SEND_EVERY = 1 / 15
const ORBITS = 4                // rings of held sparks drawn round a comet, three sparks to a ring
const PORTAL_SIZE = 1.9         // a portal is a landmark: several times the size of a comet
const FULL = 90                 // seconds of time at which a topic's rim reads as full
const TOPIC = 0xffa6b4          // the colour of everything that is a topic: a warm rose
const SPARK = 0xffc86b          // the colour of sparks: gold
const CREAM = 0xfff3dc
const DISPLAY = "'Grandstander', 'Nunito', sans-serif"
const BODY = "'Nunito', sans-serif"

// The inside of a portal: slow warm light, plum at the edge, rose, then cream at the heart.
// `life` (0 to 1) is how much of the rim is lit, clockwise from the top.
const PORTAL_SHADER = `
  uniform float time, life, pulse, hasPic;
  uniform vec3 tint;
  uniform sampler2D pic;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float a = atan(p.x, p.y);
    // Soft cloud wound into a slow spiral. Low frequencies only, so it reads as glow and not as streaks.
    float wind = a + (1.0 - r) * 1.8 - time * 0.22;
    vec2 q = vec2(cos(wind), sin(wind)) * (0.9 + r * 1.3);
    float n = noise(q + time * 0.08) * 0.6 + noise(q * 2.1 - time * 0.11) * 0.4;
    vec3 plum = vec3(0.17, 0.06, 0.22), cream = vec3(1.0, 0.93, 0.78);
    vec3 col = mix(plum, tint, smoothstep(0.25, 0.7, n));
    col = mix(col, cream, smoothstep(0.6, 0.95, n) * 0.6);
    col = mix(col, cream, pow(1.0 - r, 2.0) * (0.75 + pulse));         // a warm heart
    float alpha = (0.62 + n * 0.3) * smoothstep(0.9, 0.78, r);
    if (hasPic > 0.5) {
      vec2 uv = p / 0.6;
      float m = smoothstep(1.0, 0.94, length(uv));
      col = mix(col, texture2D(pic, uv * 0.5 + 0.5).rgb, m);
      alpha = mix(alpha, 1.0, m);
    }
    // The rim: lit for the share of time left, faint for the rest.
    float band = smoothstep(0.9, 0.915, r) * smoothstep(1.0, 0.985, r);
    float lit = step(fract(a / 6.28318 + 1.0), life);
    vec3 rim = life < 0.3 ? vec3(1.0, 0.5, 0.32) : cream;
    col = mix(col, rim, band);
    alpha = mix(alpha, lit > 0.5 ? 1.0 : 0.16, band);
    gl_FragColor = vec4(col, alpha);
  }`

// The skin of a topic's zone: nothing face on, a glow where you look along it. So from
// outside it is a soft bubble, and from inside only its far edge shows.
const ZONE_VERTEX = `
  varying vec3 vNormal, vView;
  void main() {
    vec4 at = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-at.xyz);
    gl_Position = projectionMatrix * at;
  }`
const ZONE_FRAGMENT = `
  uniform vec3 tint;
  uniform float strength;
  varying vec3 vNormal, vView;
  void main() {
    float edge = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.6);
    gl_FragColor = vec4(tint, edge * strength);
  }`

// A soft round dot, used for glows, dust and comet tails.
function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.3, 'rgba(255,255,255,0.55)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

// A star: a hard bright point with four thin rays and a soft glow round it.
function starTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const glow = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  glow.addColorStop(0, 'rgba(255,255,255,1)')
  glow.addColorStop(0.08, 'rgba(255,255,255,0.95)')
  glow.addColorStop(0.22, 'rgba(255,255,255,0.3)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = glow
  g.fillRect(0, 0, 128, 128)
  g.globalCompositeOperation = 'lighter'
  for (const turn of [0, Math.PI / 2]) {
    g.save(); g.translate(64, 64); g.rotate(turn)
    const ray = g.createLinearGradient(-64, 0, 64, 0)
    ray.addColorStop(0, 'rgba(255,255,255,0)'); ray.addColorStop(0.5, 'rgba(255,255,255,0.9)'); ray.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = ray
    g.fillRect(-64, -1.2, 128, 2.4)
    g.restore()
  }
  return new THREE.CanvasTexture(c)
}

// A thin circle, for the ring a collected spark leaves.
function ringTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  g.strokeStyle = '#fff'; g.lineWidth = 5
  g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.stroke()
  return new THREE.CanvasTexture(c)
}

// A line of text that always faces the camera: a comet's name, a topic's title.
function label(text, size = 44, colour = '#fff3dc') {
  const c = document.createElement('canvas')
  c.width = 512; c.height = 96
  const tex = new THREE.CanvasTexture(c)
  const draw = () => {
    const g = c.getContext('2d')
    g.clearRect(0, 0, 512, 96)
    let px = size
    g.font = `600 ${px}px ${DISPLAY}`
    g.textAlign = 'center'
    // Long text is shrunk to fit, down to a floor, then cut.
    let shown = text
    while (g.measureText(shown).width > 496 && px > 22) { px -= 2; g.font = `600 ${px}px ${DISPLAY}` }
    while (g.measureText(shown).width > 496 && shown.length > 4) shown = shown.slice(0, -2)
    if (shown !== text) shown = shown.slice(0, -1) + '…'
    g.shadowColor = 'rgba(26,16,36,0.9)'; g.shadowBlur = 10
    g.fillStyle = colour
    g.fillText(shown, 256, 62)
    tex.needsUpdate = true
  }
  draw()
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  sprite.scale.set(5, 0.94, 1)
  return sprite
}

// What a comet just said: a cream cloud over it with a small tail, wrapped to three lines.
function bubble(text) {
  const c = document.createElement('canvas')
  c.width = 512; c.height = 176
  const tex = new THREE.CanvasTexture(c)
  const draw = () => {
    const g = c.getContext('2d')
    g.clearRect(0, 0, c.width, c.height)
    g.font = `700 29px ${BODY}`
    const lines = ['']
    for (const word of text.split(/\s+/)) {
      const next = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + word : word
      if (g.measureText(next).width <= 440 || !lines[lines.length - 1]) lines[lines.length - 1] = next
      else lines.push(word)
    }
    if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].slice(0, -2) + '…' }
    const wide = Math.min(496, Math.max(...lines.map((l) => g.measureText(l).width)) + 56)
    const tall = lines.length * 38 + 30
    const x = (c.width - wide) / 2, y = c.height - tall - 18, r = Math.min(30, tall / 2)
    g.fillStyle = 'rgba(255,243,220,0.96)'
    g.beginPath()
    g.moveTo(x + r, y)
    g.arcTo(x + wide, y, x + wide, y + tall, r); g.arcTo(x + wide, y + tall, x, y + tall, r)
    g.lineTo(c.width / 2 + 13, y + tall); g.lineTo(c.width / 2 - 4, y + tall + 16); g.lineTo(c.width / 2 - 13, y + tall)
    g.arcTo(x, y + tall, x, y, r); g.arcTo(x, y, x + wide, y, r)
    g.closePath(); g.fill()
    g.fillStyle = '#2a1830'
    g.textAlign = 'center'
    lines.forEach((l, i) => g.fillText(l, c.width / 2, y + 43 + i * 38))
    tex.needsUpdate = true
  }
  draw()
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }))
  sprite.center.set(0.5, 0)                       // it grows upward from just above the comet
  sprite.scale.set(6.4, 2.2, 1)
  sprite.renderOrder = 5
  return sprite
}

export class World {
  constructor(canvas, onChange) {
    this.canvas = canvas
    this.onChange = onChange
    this.me = null
    this.zone = 17                // radius of a topic's zone; the server's value replaces it on entering
    this.edge = 115               // beyond this distance from the centre, the comet is pulled back
    this.players = new Map()      // id -> what is drawn for one comet
    this.portals = new Map()      // id -> what is drawn for one topic
    this.sparks = []
    this.bursts = []
    this.keys = { forward: false, brake: false, boost: false }
    this.velocity = new THREE.Vector3()
    this.sendIn = 0
    this.nearPortal = null
    this.voice = null             // set by voice.js when the microphone is on
    this.disposed = false

    this.setupScene()
    this.setupSound()
    this.bindKeys()
    // Behind the way in: one portal and a few sparks, so the first screen shows what the
    // place is. The server's own list replaces them on entering.
    const preview = this.makePortal({ id: 0, name: '', p: [6.5, 0.4, -7], energy: 70 }, true)
    this.portals.set('preview', preview)
    this.scene.add(preview.group)
    this.setSparks(Array.from({ length: 16 }, (_, i) => [Math.sin(i * 2.4) * (6 + i), Math.cos(i * 1.7) * 5, -6 - (i % 5) * 4]))

    this.clock = new THREE.Clock()
    this.frame = this.frame.bind(this)
    requestAnimationFrame(this.frame)
  }

  // ---------------------------------------------------------------- scene

  setupScene() {
    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)

    const scene = this.scene = new THREE.Scene()
    scene.background = new THREE.CubeTextureLoader().setPath('/environment/').load(['px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png'])

    const camera = this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1500)
    camera.position.set(0, 2, 7)

    const controls = this.controls = new OrbitControls(camera, this.canvas)
    controls.enableDamping = true
    controls.enablePan = false
    controls.minDistance = 5
    controls.maxDistance = 11
    controls.enableKeys = false
    controls.addEventListener('start', () => { this.turning = false })      // a drag takes the view back

    this.glow = glowTexture()
    this.star = starTexture()
    this.ringMap = ringTexture()

    // Dust. The sky is a picture at infinity, so without something near the comet there is
    // no sense of moving at all. These points fill a box around the camera and wrap as it flies.
    const DUST = 900, span = 80
    const dust = new Float32Array(DUST * 3)
    for (let i = 0; i < DUST * 3; i++) dust[i] = (Math.random() - 0.5) * span
    const dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dust, 3))
    this.dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ map: this.glow, size: 0.28, color: 0xffe9d2, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.dust.frustumCulled = false
    this.dustSpan = span
    scene.add(this.dust)
    // At speed every mote of dust is drawn out into a line along the way you are going.
    const streakGeo = new THREE.BufferGeometry()
    streakGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST * 6), 3))
    this.streaks = new THREE.LineSegments(streakGeo, new THREE.LineBasicMaterial({ color: 0xffe9d2, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.streaks.frustumCulled = false
    scene.add(this.streaks)

    this.onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', this.onResize)
  }

  setupSound() {
    const listener = this.listener = new THREE.AudioListener()
    this.camera.add(listener)
    const loader = new THREE.AudioLoader()
    const sound = (file, volume, loop = false) => {
      const audio = new THREE.Audio(listener)
      loader.load(file, (buffer) => { audio.setBuffer(buffer); audio.setVolume(volume); audio.setLoop(loop); if (loop && this.entered) audio.play() })
      return audio
    }
    this.music = sound('/whispiverse.mp3', 0.4, true)
    this.boostFx = sound('/boostfx.mp3', 0.18)
    this.collect = [1, 2, 3, 4].map((n) => sound(`/sounds/collect${n}.mp3`, 0.22))
  }

  bindKeys() {
    this.onKey = (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return
      const down = e.type === 'keydown'
      if (e.code === 'KeyW' || e.code === 'ArrowUp') this.keys.forward = down
      if (e.code === 'KeyS' || e.code === 'ArrowDown') this.keys.brake = down
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        if (down && !this.keys.boost && this.boostFx.buffer && !this.boostFx.isPlaying) this.boostFx.play()
        this.keys.boost = down
      }
      if (e.code === 'Space' && down && !e.repeat) { e.preventDefault(); this.onChange({ act: true }) }
    }
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKey)
  }

  // ---------------------------------------------------------------- network

  join(name) {
    this.entered = true
    if (this.music.buffer && !this.music.isPlaying) this.music.play()
    const socket = this.socket = io({ transports: ['websocket', 'polling'] })
    socket.on('connect', () => socket.emit('join', { name }))
    socket.on('connect_error', () => this.onChange({ offline: true }))

    socket.on('welcome', (w) => {
      this.me = w.me
      this.rules = w.rules
      this.zone = w.rules.zone || this.zone
      this.edge = (w.rules.world || 85) * 1.35
      w.players.forEach((p) => this.addPlayer(p))
      this.setPortals(w.portals)
      this.setSparks(w.sparks)
      this.onChange({ joined: true, me: w.me, score: 0, census: this.census(), rules: w.rules, offline: false })
    })
    socket.on('player:joined', (p) => { this.addPlayer(p); this.onChange({ census: this.census(), arrived: p }) })
    socket.on('player:left', (id) => { this.removePlayer(id); this.onChange({ census: this.census(), left: id }) })
    socket.on('tick', (t) => {
      t.players.forEach(([id, x, y, z]) => { const p = this.players.get(id); if (p && id !== this.me.id) p.target.set(x, y, z) })
      this.setSparks(t.sparks)
    })
    socket.on('spark:eaten', (e) => {
      const p = this.players.get(e.by)
      if (p) p.score = e.score
      if (this.sparks[e.index]) this.burst(this.sparks[e.index].position)
      if (this.me && e.by === this.me.id) {
        const fx = this.collect[Math.floor(Math.random() * this.collect.length)]
        if (fx.buffer) { if (fx.isPlaying) fx.stop(); fx.play() }
        this.onChange({ score: e.score, ate: true })
      }
    })
    socket.on('score', (s) => { const p = this.players.get(s.id); if (p) p.score = s.score; if (this.me && s.id === this.me.id) this.onChange({ score: s.score }) })
    socket.on('portals', (list) => this.setPortals(list))
    socket.on('portal:energy', (list) => list.forEach(([id, energy]) => this.setEnergy(id, energy)))
    socket.on('portal:thread', (t) => { const p = this.portals.get(t.id); if (p) { p.data.thread = t.thread; if (this.nearPortal && this.nearPortal.id === t.id) this.onChange({ near: { ...p.data } }) } })
    // What someone in your topic said shows as a cloud over their comet for a few seconds.
    socket.on('whisper', (line) => {
      const p = this.players.get(line.id)
      if (p) {
        if (p.bubble) p.group.remove(p.bubble)
        p.bubble = bubble(line.text)
        p.bubble.position.y = p.isMe ? 1.2 : 1.7
        if (p.isMe) p.bubble.scale.set(3, 1.03, 1)   // your own is right in front of the camera
        p.bubbleFor = 5.5
        p.group.add(p.bubble)
      }
      this.onChange({ heard: { name: line.name, text: line.text, mine: this.me && line.id === this.me.id } })
    })
    socket.on('portal:fed', (f) => { this.setEnergy(f.id, f.energy); const p = this.portals.get(f.id); if (p) p.pulse = 1 })
  }

  say(text) { return new Promise((done) => this.socket.emit('whisper', text, done)) }
  createPortal(data) { return new Promise((done) => this.socket.emit('portal:create', data, done)) }
  feedPortal(id) { return new Promise((done) => this.socket.emit('portal:feed', id, done)) }

  // ---------------------------------------------------------------- players

  // A comet is light, not a model: a star for a head, a glow in its own colour round it,
  // and a tail of the same colour laid down where it has been. Standing still it is a star.
  addPlayer(p) {
    if (this.players.has(p.id)) return
    const isMe = this.me && p.id === this.me.id
    const group = new THREE.Group()
    const colour = new THREE.Color().setHSL(p.hue / 360, 0.85, 0.72)
    const add = (map, tint, size, opacity) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, color: tint, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }))
      s.scale.setScalar(size)
      group.add(s)
      return s
    }
    const halo = add(this.glow, colour, 3.2, 0.24)
    const coma = add(this.glow, colour.clone().lerp(new THREE.Color(CREAM), 0.4), 1.2, 0.6)
    const head = add(this.star, CREAM, 1.9, 1)

    // The tail. Light is added, so a darker colour further back is a fainter point: it thins out.
    // The points overlap heavily, so each one is kept faint: together they make a solid streak.
    const TAIL = 80
    const start = new Float32Array(TAIL * 3), shade = new Float32Array(TAIL * 3)
    for (let i = 0; i < TAIL; i++) {
      start.set(p.p, i * 3)                                   // all at the comet, so no streak from the origin
      const k = Math.pow(1 - i / TAIL, 2) * 0.3
      shade.set([colour.r * k + k * 0.35, colour.g * k + k * 0.3, colour.b * k + k * 0.2], i * 3)
    }
    const tailGeo = new THREE.BufferGeometry()
    tailGeo.setAttribute('position', new THREE.BufferAttribute(start, 3))
    tailGeo.setAttribute('color', new THREE.BufferAttribute(shade, 3))
    const tail = new THREE.Points(tailGeo, new THREE.PointsMaterial({ map: this.glow, size: 0.85, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
    tail.frustumCulled = false
    this.scene.add(tail)

    let tag = null
    // A simulated comet says so in its name tag.
    if (!isMe) { tag = label(p.bot ? p.name + ' · sim' : p.name, 38); tag.scale.set(4, 0.75, 1); tag.position.y = 1.25; group.add(tag) }
    group.position.fromArray(p.p)
    this.scene.add(group)
    this.players.set(p.id, { group, head, coma, halo, tail, tag, tailAt: 0, target: new THREE.Vector3().fromArray(p.p), name: p.name, hue: p.hue, score: p.score || 0, shown: -1, glow: 3.2, isMe, bot: !!p.bot })
    if (isMe) { this.controls.target.copy(group.position); this.camera.position.copy(group.position).add(new THREE.Vector3(0, 2, 7)) }
  }

  // The sparks a comet holds circle it, three to a ring: one ring is what a topic costs.
  // So a comet's wealth can be read off it, and a rich one is ringed and bright.
  showSparks(p) {
    if (!p.orbits) p.orbits = []
    const held = Math.min(p.score, ORBITS * 3)
    for (let k = 0; k < ORBITS; k++) {
      const count = Math.max(0, Math.min(3, held - k * 3))
      let o = p.orbits[k]
      if (!o && count === 0) continue
      if (!o) {
        const r = 1.15 + k * 0.32
        const pivot = new THREE.Group()
        pivot.rotation.set(1.2 + k * 0.55, k * 1.1, 0)
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.014, 6, 72), new THREE.MeshBasicMaterial({ color: SPARK, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
        pivot.add(ring)
        const spin = new THREE.Group()
        pivot.add(spin)
        const dots = [0, 1, 2].map((j) => {
          const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.star, color: SPARK, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
          dot.position.set(Math.cos(j * 2.094) * r, Math.sin(j * 2.094) * r, 0)
          dot.scale.setScalar(0.75)
          spin.add(dot)
          return dot
        })
        p.group.add(pivot)
        o = p.orbits[k] = { pivot, ring, spin, dots, speed: (k % 2 ? -1 : 1) * (1.5 - k * 0.22) }
      }
      o.pivot.visible = count > 0
      o.dots.forEach((d, j) => { d.visible = j < count })
      o.ring.material.opacity = count === 3 ? 0.75 : 0.22       // a complete ring is lit
    }
    p.shown = p.score
    p.halo.material.opacity = 0.24 + Math.min(0.4, p.score * 0.03)
    p.glow = 3.2 + Math.min(4, p.score * 0.3)
    p.halo.scale.setScalar(p.glow)
    p.head.scale.setScalar(1.9 + Math.min(1.3, p.score * 0.09))
  }

  removePlayer(id) {
    const p = this.players.get(id)
    if (!p) return
    this.scene.remove(p.group, p.tail)
    this.players.delete(id)
  }

  // How many comets are here, and how many of those the server is flying.
  census() {
    let sims = 0
    for (const [, p] of this.players) if (p.bot) sims++
    return { count: this.players.size, sims }
  }

  // ---------------------------------------------------------------- sparks

  setSparks(list) {
    while (this.sparks.length < list.length) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.star, color: SPARK, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
      s.scale.setScalar(1.5)
      s.userData.target = new THREE.Vector3()
      this.scene.add(s)
      this.sparks.push(s)
    }
    // The preview before entering has fewer sparks than the server; the rest wait out of sight.
    this.sparks.forEach((s, i) => { s.visible = i < list.length })
    list.forEach((p, i) => {
      const s = this.sparks[i], t = s.userData.target
      // A spark that was collected reappears far away: it jumps there, it does not streak across.
      if (t.distanceToSquared(new THREE.Vector3(p[0], p[1], p[2])) > 100) s.position.set(p[0], p[1], p[2])
      t.set(p[0], p[1], p[2])
    })
  }

  // A collected spark goes out with a flash and a ring that opens and fades where it was.
  burst(at) {
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xffe2b0, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }))
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ringMap, color: SPARK, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }))
    ring.userData.ring = true
    for (const s of [flash, ring]) {
      s.position.copy(at)
      s.userData.age = 0
      this.scene.add(s)
      this.bursts.push(s)
    }
  }

  // ---------------------------------------------------------------- the map, the radar, the guide

  // The whole world from above, for the map: every topic with who is gathered in its zone,
  // every comet, every spark.
  snapshot() {
    const mine = this.me && this.players.get(this.me.id)
    if (!mine) return null
    const comets = [...this.players.values()].map((p) => ({ name: p.name, x: p.group.position.x, z: p.group.position.z, me: p.isMe, bot: p.bot, at: p.group.position }))
    const look = new THREE.Vector3().subVectors(mine.group.position, this.camera.position)
    return {
      heading: Math.atan2(look.x, -look.z),
      zone: this.zone,
      comets,
      sparks: this.sparks.filter((s) => s.visible).map((s) => [s.position.x, s.position.z]),
      topics: [...this.portals.values()].map((p) => ({
        id: p.data.id, name: p.data.name, owner: p.data.owner, energy: p.data.energy,
        x: p.group.position.x, z: p.group.position.z,
        here: comets.filter((c) => c.at.distanceTo(p.group.position) < this.zone).length,
        away: Math.round(p.group.position.distanceTo(mine.group.position)),
      })),
    }
  }

  // Where the player has asked to be guided to: a topic picked on the map.
  // Picking one also swings the camera round to face it, until the player takes the view back.
  setWaypoint(id) { this.waypoint = id; this.turning = id != null }
  waypointInfo() {
    const p = this.waypoint != null && this.portals.get(this.waypoint)
    const mine = this.me && this.players.get(this.me.id)
    if (!p || !mine) { this.waypoint = null; return null }
    return { name: p.data.name, away: Math.round(p.group.position.distanceTo(mine.group.position)), at: p.group.position }
  }

  // The topic nearest to you, for when you are in none.
  nearestTopic() {
    const mine = this.me && this.players.get(this.me.id)
    if (!mine) return null
    let best = null
    for (const [, p] of this.portals) {
      const away = p.group.position.distanceTo(mine.group.position)
      if (!best || away < best.away) best = { id: p.data.id, name: p.data.name, away: Math.round(away) }
    }
    return best
  }

  // The guide in the sky: a run of dots leaving the comet toward the topic it is heading to,
  // each one sliding outward, so the direction reads at a glance.
  drawGuide(mine, now) {
    const way = mine && this.waypointInfo()
    if (!this.guideDots) {
      this.guideDots = []
      for (let i = 0; i < 9; i++) {
        const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.star, color: TOPIC, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
        dot.visible = false
        this.scene.add(dot)
        this.guideDots.push(dot)
      }
    }
    if (!way) { this.guideDots.forEach((d) => { d.visible = false }); return }
    const dir = way.at.clone().sub(mine.group.position)
    const far = dir.length()
    dir.normalize()
    this.guideDots.forEach((dot, i) => {
      const k = ((i + (now * 1.6) % 1) / this.guideDots.length)       // 0 at the comet, 1 at the far end
      const reach = 3 + k * Math.min(26, far)
      dot.visible = reach < far
      dot.position.copy(mine.group.position).addScaledVector(dir, reach)
      dot.scale.setScalar(1.5 - k * 0.7)
      dot.material.opacity = Math.sin(k * Math.PI) * 0.95
    })
  }

  // What the radar draws: everything near the comet, relative to it and turned so that
  // "up" is the way the camera is looking.
  radar(range) {
    const mine = this.me && this.players.get(this.me.id)
    if (!mine) return null
    const here = mine.group.position
    const look = new THREE.Vector3().subVectors(here, this.camera.position)
    const yaw = Math.atan2(look.x, look.z)
    const cos = Math.cos(yaw), sin = Math.sin(yaw)
    const place = (v, reach = range) => {
      const dx = v.x - here.x, dz = v.z - here.z
      if (Math.hypot(dx, dz) > reach) return null
      // right is +x on the dial, ahead is up
      return [(dx * cos - dz * sin) / range, -(dx * sin + dz * cos) / range, v.y - here.y]
    }
    const keep = (list, reach) => list.map((v) => place(v, reach)).filter(Boolean)
    // The waypoint is shown even beyond the dial's range, pinned to its rim.
    let guide = null
    const way = this.waypointInfo()
    if (way) {
      const dx = way.at.x - here.x, dz = way.at.z - here.z, d = Math.hypot(dx, dz) || 1
      const k = Math.min(1, d / range) / d
      guide = [(dx * cos - dz * sin) * k, -(dx * sin + dz * cos) * k]
    }
    return {
      guide,
      zone: this.zone / range,
      sparks: keep(this.sparks.filter((s) => s.visible).map((s) => s.position)),
      portals: keep([...this.portals.values()].map((p) => p.group.position), range + this.zone),
      comets: keep([...this.players.values()].filter((p) => !p.isMe).map((p) => p.group.position)),
    }
  }

  // ---------------------------------------------------------------- portals

  setPortals(list) {
    const alive = new Set(list.map((p) => p.id))
    for (const [id, p] of this.portals) if (!alive.has(id)) { this.scene.remove(p.group); this.portals.delete(id) }
    list.forEach((data) => {
      const had = this.portals.get(data.id)
      if (had) { had.data = data; return }
      const made = this.makePortal(data)
      this.scene.add(made.group)
      this.portals.set(data.id, made)
    })
    this.onChange({ portalCount: this.portals.size })
  }

  // A portal is a window that always faces you: slow warm light with the topic's picture at
  // its heart, a rim that empties as the topic runs out of time, and two rings turning round it.
  // Round the portal is the topic's zone, the only place it can be talked in. It is drawn
  // three ways so it cannot be missed: a faint bubble, two dotted hoops on its surface, and
  // fireflies that fill it and stop at its edge.
  makePortal(data, preview) {
    const group = new THREE.Group()
    const core = new THREE.Group()
    group.add(core)
    const uniforms = {
      time: { value: 0 }, life: { value: 1 }, pulse: { value: 1 },
      tint: { value: new THREE.Color(TOPIC) },
      pic: { value: null }, hasPic: { value: 0 },
    }
    if (data.image) new THREE.TextureLoader().load(data.image, (t) => { uniforms.pic.value = t; uniforms.hasPic.value = 1 })
    const disc = new THREE.Mesh(new THREE.CircleGeometry(2.3, 64), new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: PORTAL_SHADER,
    }))
    core.add(disc)

    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd9c2, transparent: true, opacity: 0.8 })
    const rings = [new THREE.Mesh(new THREE.TorusGeometry(2.62, 0.028, 8, 96), ringMat), new THREE.Mesh(new THREE.TorusGeometry(2.95, 0.02, 8, 96), ringMat)]
    rings[1].rotation.x = 1.1
    rings.forEach((r) => core.add(r))

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: TOPIC, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }))
    halo.scale.setScalar(13)
    core.add(halo)

    const name = label(data.name, 44)
    name.scale.set(7.4, 1.39, 1)
    name.position.y = 3.9
    core.add(name)

    const made = { group, core, disc, rings, halo, uniforms, data, pulse: 1 }
    if (!preview) {
      const R = this.zone
      const shellUniforms = { tint: { value: new THREE.Color(TOPIC) }, strength: { value: 0.5 } }
      const shell = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), new THREE.ShaderMaterial({
        uniforms: shellUniforms, vertexShader: ZONE_VERTEX, fragmentShader: ZONE_FRAGMENT,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }))
      group.add(shell)

      const hoop = () => {
        const N = 96, at = new Float32Array(N * 3)
        for (let i = 0; i < N; i++) at.set([Math.cos(i / N * Math.PI * 2) * R, 0, Math.sin(i / N * Math.PI * 2) * R], i * 3)
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(at, 3))
        return new THREE.Points(geo, new THREE.PointsMaterial({ map: this.glow, size: 0.42, color: TOPIC, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }))
      }
      const hoops = [hoop(), hoop()]
      hoops[1].rotation.x = Math.PI / 2
      hoops.forEach((h) => group.add(h))

      const FLIES = 130, at = new Float32Array(FLIES * 3)
      for (let i = 0; i < FLIES; i++) {
        // Evenly through the ball, none past its edge and none inside the portal itself.
        const dir = new THREE.Vector3().randomDirection().multiplyScalar(R * (0.32 + 0.66 * Math.cbrt(Math.random())))
        at.set([dir.x, dir.y, dir.z], i * 3)
      }
      const flyGeo = new THREE.BufferGeometry()
      flyGeo.setAttribute('position', new THREE.BufferAttribute(at, 3))
      const flies = new THREE.Points(flyGeo, new THREE.PointsMaterial({ map: this.glow, size: 0.34, color: 0xffe2a8, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }))
      group.add(flies)
      Object.assign(made, { shell, shellUniforms, hoops, flies })
    }
    group.position.fromArray(data.p)
    return made
  }

  setEnergy(id, energy) {
    const p = this.portals.get(id)
    if (p) p.data.energy = energy
  }

  // ---------------------------------------------------------------- frame

  frame() {
    if (this.disposed) return
    requestAnimationFrame(this.frame)
    const dt = Math.min(this.clock.getDelta(), 0.05)
    const now = this.clock.elapsedTime
    const mine = this.me && this.players.get(this.me.id)

    if (mine) {
      // Thrust goes where the camera looks: out from the camera through the comet. The comet
      // keeps its speed and loses it to drag, so letting go is a glide and not a stop.
      const heading = new THREE.Vector3().subVectors(mine.group.position, this.camera.position).normalize()
      const top = this.keys.boost ? 26 : 11
      if (this.keys.forward) this.velocity.addScaledVector(heading, (this.keys.boost ? 46 : 22) * dt)
      const drag = this.keys.brake ? 3.2 : this.keys.forward ? 0.9 : 1.3
      this.velocity.multiplyScalar(Math.exp(-drag * dt))
      if (this.velocity.length() > top) this.velocity.setLength(top + (this.velocity.length() - top) * Math.exp(-4 * dt))
      // The world has no wall. Past its edge a pull toward the middle grows with distance,
      // so a comet that wanders off is turned round, gently.
      const out = mine.group.position.length() - this.edge
      if (out > 0) this.velocity.addScaledVector(mine.group.position.clone().normalize(), -Math.min(30, out * 0.9) * dt)
      const step = this.velocity.clone().multiplyScalar(dt)
      mine.group.position.add(step)
      this.camera.position.add(step)              // the camera rides along, keeping its orbit
      this.controls.target.copy(mine.group.position)
      this.camera.fov += ((this.keys.boost && this.keys.forward ? 84 : 70) - this.camera.fov) * Math.min(1, dt * 4)
      this.camera.updateProjectionMatrix()

      this.sendIn -= dt
      if (this.sendIn <= 0 && this.socket) { this.sendIn = SEND_EVERY; this.socket.volatile.emit('move', mine.group.position.toArray()) }
    } else {
      // Before entering, the view drifts a little so the first screen is not a still.
      this.camera.position.set(Math.sin(now * 0.12) * 1.6, 2 + Math.sin(now * 0.09) * 0.5, 7)
    }
    if (this.turning && mine) {
      const way = this.waypointInfo()
      if (!way) this.turning = false
      else {
        const back = mine.group.position.clone().sub(way.at).normalize()
        const reach = this.camera.position.distanceTo(mine.group.position)
        const want = mine.group.position.clone().addScaledVector(back, reach * 0.96).add(new THREE.Vector3(0, reach * 0.28, 0))
        this.camera.position.lerp(want, Math.min(1, dt * 3.5))
        if (this.camera.position.distanceTo(want) < 0.15) this.turning = false
      }
    }
    this.controls.update()
    this.drawGuide(mine, now)

    // Which topic's zone you are in, if any.
    let near = null, nearD = this.zone
    for (const [, p] of this.portals) {
      if (!mine || !p.shell) continue
      const d = p.group.position.distanceTo(mine.group.position)
      if (d < nearD) { nearD = d; near = p }
    }

    const speed = this.velocity.length()
    let i = 0
    for (const [id, p] of this.players) {
      i++
      if (!p.isMe) p.group.position.lerp(p.target, Math.min(1, dt * 10))
      // Lay the tail: the newest point at the comet, the rest shifted back.
      p.tailAt -= dt
      if (p.tailAt <= 0) {
        // Your own tail is kept short: the camera sits behind you, and a long one would run through it.
        p.tailAt = p.isMe ? 0.005 : 0.022
        const a = p.tail.geometry.attributes.position.array
        a.copyWithin(3, 0, a.length - 3)
        a[0] = p.group.position.x; a[1] = p.group.position.y; a[2] = p.group.position.z
        p.tail.geometry.attributes.position.needsUpdate = true
      }
      // The head twinkles and turns; the sparks it holds circle it.
      p.head.material.rotation = now * 0.25 + i
      p.coma.scale.setScalar(1.2 + Math.sin(now * 3 + i * 2.1) * 0.12)
      if (p.shown !== p.score) this.showSparks(p)
      if (p.orbits) p.orbits.forEach((o) => { if (o) o.spin.rotation.z += dt * o.speed })
      if (p.isMe) p.halo.scale.setScalar(p.glow + speed * 0.06)
      if (p.bubble) {
        p.bubbleFor -= dt
        p.bubble.material.opacity = Math.min(1, p.bubbleFor)
        if (p.bubbleFor <= 0) { p.group.remove(p.bubble); p.bubble = null }
      }
      // You hear a voice only when you and its comet are in the same topic, louder the nearer.
      if (this.voice && mine && !p.isMe) {
        const together = near && p.group.position.distanceTo(near.group.position) < this.zone
        if (together) this.voice.setDistance(id, p.group.position.distanceTo(mine.group.position), this.zone * 2.5)
        else this.voice.setDistance(id, 1, 1)
      }
    }

    this.sparks.forEach((s, n) => {
      if (!s.visible) return
      s.position.lerp(s.userData.target, Math.min(1, dt * 8))
      // Each spark twinkles on its own beat and turns slowly; one being pulled in brightens on the way.
      let size = 1.5 + Math.sin(now * 2.3 + n * 1.7) * 0.35 + Math.sin(now * 7.1 + n) * 0.1
      if (mine) { const away = s.position.distanceTo(mine.group.position); if (away < 13) size *= 1 + (1 - away / 13) * 0.9 }
      s.scale.setScalar(size)
      s.material.rotation = now * 0.3 + n
    })
    for (let n = this.bursts.length - 1; n >= 0; n--) {
      const f = this.bursts[n]
      f.userData.age += dt
      const k = f.userData.age / 0.55
      if (k >= 1) { this.scene.remove(f); this.bursts.splice(n, 1); continue }
      f.scale.setScalar(f.userData.ring ? 1 + (1 - Math.pow(1 - k, 3)) * 8 : 2 + k * 7)
      f.material.opacity = f.userData.ring ? (1 - k) * 0.9 : Math.pow(1 - k, 2)
    }

    for (const [, p] of this.portals) {
      p.disc.quaternion.copy(this.camera.quaternion)
      p.rings[0].rotation.y += dt * 0.5
      p.rings[0].rotation.x += dt * 0.17
      p.rings[1].rotation.y -= dt * 0.33
      p.rings[1].rotation.z += dt * 0.21
      // A portal shrinks and dims as its time runs down, and swells when it is fed.
      const life = Math.min(1, p.data.energy / FULL)
      p.pulse = Math.max(0, p.pulse - dt * 1.5)
      p.core.scale.setScalar(PORTAL_SIZE * (0.72 + life * 0.28) * (1 + p.pulse * 0.25))
      p.uniforms.time.value = now + p.data.id * 7.3
      p.uniforms.life.value += (life - p.uniforms.life.value) * Math.min(1, dt * 4)
      p.uniforms.pulse.value = p.pulse
      p.halo.material.opacity = 0.12 + life * 0.14 + p.pulse * 0.4
      if (p.shell) {
        // The zone you are in is the bright one.
        const inside = p === near
        p.shellUniforms.strength.value += ((inside ? 0.85 : 0.45) - p.shellUniforms.strength.value) * Math.min(1, dt * 3)
        p.hoops[0].rotation.y += dt * 0.06
        p.hoops[1].rotation.z += dt * 0.045
        p.flies.rotation.y += dt * 0.05
        p.flies.rotation.x = Math.sin(now * 0.1 + p.data.id) * 0.2
        p.flies.material.opacity = (inside ? 0.95 : 0.6) + Math.sin(now * 1.4 + p.data.id) * 0.12
      }
    }
    const nearData = near ? near.data : null
    if ((nearData && nearData.id) !== (this.nearPortal && this.nearPortal.id) || (nearData && nearData.energy !== this.nearEnergy)) {
      this.nearPortal = nearData
      this.nearEnergy = nearData ? nearData.energy : null
      this.onChange({ near: nearData ? { ...nearData } : null })
    }

    // Keep the dust box centred on the camera, wrapping points that fall out of it.
    const d = this.dust.geometry.attributes.position.array, half = this.dustSpan / 2, c = this.camera.position
    for (let n = 0; n < d.length; n += 3) {
      for (let k = 0; k < 3; k++) {
        const centre = k === 0 ? c.x : k === 1 ? c.y : c.z
        if (d[n + k] - centre > half) d[n + k] -= this.dustSpan
        else if (d[n + k] - centre < -half) d[n + k] += this.dustSpan
      }
    }
    this.dust.geometry.attributes.position.needsUpdate = true
    const drawn = Math.max(0, Math.min(1, (speed - 9) / 14))        // nothing below cruising speed
    this.streaks.material.opacity += (drawn * 0.55 - this.streaks.material.opacity) * Math.min(1, dt * 5)
    this.streaks.visible = this.streaks.material.opacity > 0.01
    if (this.streaks.visible) {
      const s = this.streaks.geometry.attributes.position.array
      const lx = this.velocity.x * 0.07, ly = this.velocity.y * 0.07, lz = this.velocity.z * 0.07
      for (let n = 0, j = 0; n < d.length; n += 3, j += 6) {
        s[j] = d[n]; s[j + 1] = d[n + 1]; s[j + 2] = d[n + 2]
        s[j + 3] = d[n] + lx; s[j + 4] = d[n + 1] + ly; s[j + 5] = d[n + 2] + lz
      }
      this.streaks.geometry.attributes.position.needsUpdate = true
    }

    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.disposed = true
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKey)
    if (this.socket) this.socket.close()
    if (this.music.isPlaying) this.music.stop()
    this.renderer.dispose()
  }
}
