import Peer from 'peerjs'

// Voice, peer to peer. It is off until the player turns the microphone on, because a
// browser asks for permission and the world should work without it.
//
// Each player's peer id is made from their socket id, so knowing who is in the room is
// enough to call them. The audio never goes through the Whispiverse server.
const peerId = (socketId) => 'whispi-' + socketId.replace(/[^a-zA-Z0-9]/g, '')

export class Voice {
  constructor(myId, stream) {
    this.stream = stream
    this.calls = new Map()        // socket id -> { call, audio }
    this.peer = new Peer(peerId(myId))
    this.peer.on('call', (call) => {
      call.answer(stream)
      this.attach(call.metadata && call.metadata.from, call)
    })
  }

  static async start(myId) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    return new Voice(myId, stream)
  }

  // Ring someone who is already in the room.
  call(theirId, myId) {
    if (this.calls.has(theirId)) return
    const dial = () => this.attach(theirId, this.peer.call(peerId(theirId), this.stream, { metadata: { from: myId } }))
    if (this.peer.open) dial(); else this.peer.once('open', dial)
  }

  attach(theirId, call) {
    if (!call || !theirId) return
    const audio = new Audio()
    audio.autoplay = true
    audio.volume = 0
    call.on('stream', (remote) => { audio.srcObject = remote })
    call.on('close', () => this.hangUp(theirId))
    this.calls.set(theirId, { call, audio })
  }

  // Called every frame by the world: full volume beside you, silent at `far`.
  setDistance(theirId, distance, far) {
    const entry = this.calls.get(theirId)
    if (!entry) return
    const near = Math.max(0, 1 - distance / far)
    entry.audio.volume = near * near
  }

  hangUp(theirId) {
    const entry = this.calls.get(theirId)
    if (!entry) return
    entry.call.close()
    entry.audio.srcObject = null
    this.calls.delete(theirId)
  }

  stop() {
    for (const id of [...this.calls.keys()]) this.hangUp(id)
    this.stream.getTracks().forEach((t) => t.stop())
    this.peer.destroy()
  }
}
