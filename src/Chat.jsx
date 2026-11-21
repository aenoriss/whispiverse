import React from 'react'
import './chat.css'

// The topic's room: a pane of dark glass down the right edge. At the top what the topic is
// and how long it has, then who is here, then the talk, then a place to type.

const STAR = 'M0-11C1.4-3.2 3.2-1.4 11 0 3.2 1.4 1.4 3.2 0 11-1.4 3.2-3.2 1.4-11 0-3.2-1.4-1.4-3.2 0-11Z'
const Star = () => <svg className="star" viewBox="-12 -12 24 24" aria-hidden="true"><path d={STAR} /></svg>

// A comet's own colour, the one it has in the sky.
const tint = (hue) => `hsl(${hue > 15 && hue < 75 ? hue + 80 : hue} 85% 74%)`
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 8 ? 'now' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`
}

// Who someone is at a glance: a disc in their colour with their initial.
const Face = ({ who, me }) => <i className={'face' + (me ? ' me' : '')} style={{ background: tint(who.hue) }}>{(who.name || '?')[0].toUpperCase()}</i>

export default function Chat({ topic, here, myId, score, rules, draft, setDraft, onSend, onFeed, open, setOpen, inputRef, talkRef }) {
  const thread = topic.thread || []
  const level = topic.level || 1, fed = topic.fed || 0, cap = topic.cap || 120
  const left = Math.min(1, topic.energy / cap)
  const low = topic.energy < 30
  const others = here.filter((h) => !h.me)
  const last = thread[thread.length - 1]

  return (
    <aside className={'room' + (open ? '' : ' shut')}>
      <button className="room-tab" type="button" onClick={() => setOpen(!open)} aria-label={open ? 'Hide the chat' : 'Show the chat'}>
        {open ? '›' : <><Star />{thread.length > 0 && <b>{thread.length}</b>}</>}
      </button>

      <header className="room-head">
        <div className="room-title">
          {/* The topic's own star, with a point of light for each level it has reached. */}
          <span className={'emblem l' + level}><Star /></span>
          <div>
            <h2>{topic.name}</h2>
            {topic.description && <p>{topic.description}</p>}
          </div>
        </div>
        {topic.image ? <img src={topic.image} alt="" /> : null}

        {/* How long it has: a wick that burns down, with the button that lengthens it. */}
        <div className={'room-life' + (low ? ' low' : '')}>
          <div className="wick"><i style={{ width: `${left * 100}%` }} /></div>
          <time>{clock(topic.energy)}</time>
          <button type="button" className="room-feed" onClick={onFeed} disabled={score < 1} title={`One spark adds ${rules.feed} seconds`}>
            <Star />{score < 1 ? 'No sparks' : 'Feed'}
          </button>
        </div>
        <p className="room-meta">
          <b>Level {level}</b>
          {fed} given{level < 3 && <>, {(level === 2 ? 25 : 10) - fed} to grow</>}
          <span>opened by {topic.owner}</span>
        </p>

        <div className="room-people">
          <div className="faces">
            {here.slice(0, 8).map((h) => <Face key={h.id} who={h} me={h.me} />)}
            {here.length > 8 && <i className="face more">+{here.length - 8}</i>}
          </div>
          <span>{others.length === 0 ? 'Only you here' : others.length === 1 ? `You and ${others[0].name}` : `You and ${others.length} others`}</span>
        </div>
      </header>

      <ol className="room-talk" ref={talkRef}>
        {thread.length === 0 && <li className="quiet"><Star /><p>Nobody has said anything here yet.<br />Start it off.</p></li>}
        {thread.map((l, i) => {
          const mine = l.id === myId
          const first = i === 0 || thread[i - 1].id !== l.id
          const last = i === thread.length - 1 || thread[i + 1].id !== l.id
          return (
            <li key={l.t + ':' + i} className={'msg' + (mine ? ' mine' : '') + (first ? ' first' : '') + (last ? ' last' : '')}>
              {!mine && (first ? <Face who={l} /> : <i className="face none" />)}
              <div>
                {first && !mine && <b style={{ color: tint(l.hue) }}>{l.name}{l.bot && <small>sim</small>}<time>{ago(l.t)}</time></b>}
                <p>{l.text}</p>
              </div>
            </li>
          )
        })}
      </ol>

      <form className="room-say" onSubmit={onSend}>
        <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={140} placeholder="Say something" />
        <button aria-label="Send" disabled={!draft.trim()}><Star /></button>
        {/* One quiet line under the field: the key that gets you in, and the one that gets you out. */}
        <p className="keys-line"><span className="idle"><kbd>Enter</kbd> to type</span><span className="busy"><kbd>Enter</kbd> to send, <kbd>Esc</kbd> to fly again</span></p>
      </form>

      {/* Slid away, the room still lets you know when someone speaks: the newest line peeks
          out beside the tab for a few seconds. */}
      {!open && last && <p className="room-peek" key={thread.length}><b style={{ color: tint(last.hue) }}>{last.name}</b>{last.text}</p>}
    </aside>
  )
}
