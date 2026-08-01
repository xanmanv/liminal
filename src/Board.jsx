import { useState, useRef, useEffect } from 'react'
import mammoth from 'mammoth'
import './board.css'

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY
const WORKER_URL    = import.meta.env.VITE_WORKER_URL
const WORKER_KEY    = import.meta.env.VITE_LIMINAL_KEY

async function workerFetch(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'X-Liminal-Key': WORKER_KEY } }
  if (body !== null) opts.body = JSON.stringify(body)
  return fetch(`${WORKER_URL}${path}`, opts)
}

async function askClaude(system, userMsg) {
  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages: [{ role: 'user', content: userMsg }] })
  })
  if (!r.ok) { const t = await r.text(); throw new Error(`API ${r.status}: ${t}`) }
  const d = await r.json()
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error))
  return d.content.find(b => b.type === 'text')?.text || ''
}

async function askClaudeWithContent(system, textPrompt, mediaContent) {
  const contentBlocks = []
  if (mediaContent) {
    if (mediaContent.type === 'document') contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: mediaContent.mediaType, data: mediaContent.data } })
    else if (mediaContent.type === 'image') contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaContent.mediaType, data: mediaContent.data } })
  }
  contentBlocks.push({ type: 'text', text: textPrompt })
  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages: [{ role: 'user', content: contentBlocks }] })
  })
  if (!r.ok) { const t = await r.text(); throw new Error(`API ${r.status}: ${t}`) }
  const d = await r.json()
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error))
  return d.content.find(b => b.type === 'text')?.text || ''
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const CANVAS_W  = 3000
const CANVAS_H  = 3000
const CANVAS_CX = 1500
const CANVAS_CY = 1500
const ZOOM_MIN  = 0.5
const ZOOM_MAX  = 2.0
const ZOOM_STEP = 0.1

const ACCENTS = [
  { bg: '#2563EB', text: '#FFFFFF' },
  { bg: '#16A34A', text: '#FFFFFF' },
  { bg: '#DC2626', text: '#FFFFFF' },
  { bg: '#9333EA', text: '#FFFFFF' },
  { bg: '#D97706', text: '#FFFFFF' },
  { bg: '#0891B2', text: '#FFFFFF' },
  { bg: '#BE185D', text: '#FFFFFF' },
  { bg: '#4B5563', text: '#FFFFFF' },
]

const CARD_W         = 162
const CARD_H         = 155
const ATTRACT_DIST   = 240
const REPEL_DIST     = 175
const DRIFT_SPEED    = 0.3
const MAX_MOVE       = 1.2
const DRIFT_INTERVAL = 60
const DRAG_PAUSE     = 5000

function tagOverlap(a, b) {
  const setA = new Set(a.map(t => t.toLowerCase()))
  return b.filter(t => setA.has(t.toLowerCase())).length
}

function LiminalCard({ card, isDragging, onDragStart, onDetail }) {
  const ac = ACCENTS[card.accentIndex ?? 0]
  return (
    <div
      className={`card ${isDragging ? 'card--dragging' : ''}`}
      onMouseDown={e => onDragStart(e, card.id)}
      onTouchStart={e => onDragStart(e, card.id)}
      style={{ left: card.x, top: card.y }}
    >
      <div className="card-header" style={{ background: ac.bg }}>
        <span style={{ color: ac.text }}>{card.title.slice(0, 55)}{card.title.length > 55 ? '…' : ''}</span>
      </div>
      <div className="card-body">
        {card.tags.slice(0, 2).map(t => <span key={t} className="tag">{t}</span>)}
        <span className="dot" />
      </div>
      <div className="card-actions" data-actions="true">
        <button onClick={onDetail}>detail</button>
      </div>
    </div>
  )
}

function TagConfirm({ pending, onConfirm, onDiscard }) {
  const [tags, setTags] = useState([...pending.tags])
  const updateTag = (i, v) => setTags(t => { const n = [...t]; n[i] = v; return n })
  return (
    <div className="confirm-bar">
      <span className="confirm-title">"{pending.title.slice(0, 32)}{pending.title.length > 32 ? '…' : ''}"</span>
      <span className="confirm-label">Tags:</span>
      {tags.map((t, i) => <input key={i} value={t} onChange={e => updateTag(i, e.target.value)} className="tag-input" />)}
      <button onClick={() => onConfirm(tags)}>Add to board</button>
      <button className="btn-ghost" onClick={onDiscard}>Discard</button>
    </div>
  )
}

function AddModal({ onClose, onPending, setError, setStatus }) {
  const [mode, setMode] = useState('note')
  const [noteText, setNoteText] = useState('')
  const [loading, setLoading] = useState(false)
  const fileRef = useRef(null)

  async function handleNote() {
    if (!noteText.trim()) return
    setLoading(true); setStatus('Reading…')
    try {
      const raw = await askClaude('You extract metadata from text content. Return only valid JSON.', `Text:\n\n${noteText}\n\nReturn: {"title":"concise title max 60 chars","tags":["tag1","tag2"],"description":"1-2 sentence summary"}`)
      const meta = JSON.parse(raw.replace(/```json|```/g, '').trim())
      setStatus(''); onPending({ sourceType: 'note', content: noteText, url: null, ...meta }); onClose()
    } catch(e) { setError(e.message || String(e)); setStatus('') }
    setLoading(false)
  }

  async function handleFile(file) {
    if (!file) return
    setLoading(true); setStatus(`Reading ${file.name}...`)
    try {
      const isPDF = file.type === 'application/pdf'
      const isTXT = file.type === 'text/plain' || file.name.endsWith('.txt')
      const isMD  = file.name.endsWith('.md')
      const isDOC = file.name.endsWith('.docx') || file.name.endsWith('.doc')
      let raw, meta
      if (isTXT || isMD) {
        const text = await file.text()
        raw = await askClaude('You extract metadata from text. Return only valid JSON.', `Content:\n\n${text.slice(0,8000)}\n\nReturn: {"title":"concise title max 60 chars","tags":["tag1","tag2"],"description":"1-2 sentence summary"}`)
        meta = JSON.parse(raw.replace(/```json|```/g,'').trim())
        setStatus(''); onPending({ sourceType: isMD?'md':'txt', content: text, fileName: file.name, url: null, ...meta }); onClose()
      } else if (isDOC) {
        const ab = await file.arrayBuffer()
        const result = await mammoth.extractRawText({ arrayBuffer: ab })
        raw = await askClaude('You extract metadata from documents. Return only valid JSON.', `Doc:\n\n${result.value.slice(0,8000)}\n\nReturn: {"title":"concise title max 60 chars","tags":["tag1","tag2"],"description":"1-2 sentence summary"}`)
        meta = JSON.parse(raw.replace(/```json|```/g,'').trim())
        setStatus(''); onPending({ sourceType:'doc', content: result.value, fileName: file.name, url: null, ...meta }); onClose()
      } else if (isPDF) {
        const base64 = await fileToBase64(file)
        raw = await askClaudeWithContent('You extract key ideas from documents. Return only valid JSON.', 'Return: {"title":"concise title max 60 chars","tags":["tag1","tag2"],"description":"1-2 sentence summary"}', { type:'document', data: base64, mediaType: file.type })
        meta = JSON.parse(raw.replace(/```json|```/g,'').trim())
        setStatus(''); onPending({ sourceType:'pdf', content:null, fileName: file.name, url:null, ...meta }); onClose()
      } else {
        const base64 = await fileToBase64(file)
        raw = await askClaudeWithContent('You extract key ideas from images. Return only valid JSON.', 'Return: {"title":"concise title max 60 chars","tags":["tag1","tag2"],"description":"1-2 sentence summary"}', { type:'image', data: base64, mediaType: file.type })
        meta = JSON.parse(raw.replace(/```json|```/g,'').trim())
        setStatus(''); onPending({ sourceType:'image', content:null, fileName: file.name, url:null, ...meta }); onClose()
      }
    } catch(e) { setError(e.message || String(e)); setStatus('') }
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-tabs">
            {[['note','Note'],['pdf','PDF'],['image','Image'],['txt','Text'],['doc','Word'],['md','MD']].map(([m,label]) => (
              <button key={m} className={`modal-tab ${mode===m?'active':''}`} onClick={() => setMode(m)}>{label}</button>
            ))}
          </div>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>
        {mode === 'note' && (
          <div className="modal-body">
            <textarea autoFocus placeholder="Type or paste your idea..." value={noteText} onChange={e => setNoteText(e.target.value)} className="note-textarea" />
            <button onClick={handleNote} disabled={loading || !noteText.trim()} className="modal-add-btn">{loading ? 'Reading...' : 'Add to board'}</button>
          </div>
        )}
        {(mode !== 'note') && (
          <div className="modal-body">
            <div className="drop-zone" onClick={() => !loading && fileRef.current?.click()}>
              <input ref={fileRef} type="file"
                accept={mode==='pdf'?'.pdf':mode==='txt'?'.txt':mode==='md'?'.md':mode==='doc'?'.doc,.docx':'image/*'}
                style={{display:'none'}} onChange={e => handleFile(e.target.files[0])} />
              <div className="drop-zone-icon">{mode==='pdf'?'PDF':mode==='txt'?'TXT':mode==='md'?'MD':mode==='doc'?'DOC':'IMG'}</div>
              <div className="drop-zone-text">{loading ? 'Reading...' : `Click to select a ${mode} file`}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DetailPanel({ card, cards, onClose, onUpdate, onDelete }) {
  const [editTitle, setEditTitle]   = useState(false)
  const [titleVal, setTitleVal]     = useState(card.title)
  const [tags, setTags]             = useState([...card.tags])
  const [editingTag, setEditingTag] = useState(null)
  const [tagVal, setTagVal]         = useState('')

  function saveTitle() { onUpdate(card.id, { title: titleVal }); setEditTitle(false) }
  function saveTag(i)  { const n=[...tags]; n[i]=tagVal; setTags(n); onUpdate(card.id,{tags:n}); setEditingTag(null) }
  function removeTag(i){ const n=tags.filter((_,idx)=>idx!==i); setTags(n); onUpdate(card.id,{tags:n}) }
  function addTag()    { if(tags.length>=6)return; const n=[...tags,'new-tag']; setTags(n); setEditingTag(n.length-1); setTagVal('new-tag') }
  const connected = cards.filter(c => c.id !== card.id && tagOverlap(card.tags, c.tags) > 0)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <span>Idea detail</span>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>
        {editTitle
          ? <input autoFocus value={titleVal} onChange={e=>setTitleVal(e.target.value)} onBlur={saveTitle} onKeyDown={e=>e.key==='Enter'&&saveTitle()} className="edit-title-input" />
          : <div className="panel-title editable" onClick={()=>setEditTitle(true)}>{card.title} <span className="edit-hint">e</span></div>
        }
        <div className="panel-desc">{card.description}</div>
        <div className="panel-tags">
          {tags.map((t,i) => editingTag===i
            ? <input key={i} autoFocus value={tagVal} onChange={e=>setTagVal(e.target.value)} onBlur={()=>saveTag(i)} onKeyDown={e=>e.key==='Enter'&&saveTag(i)} className="tag-input" style={{width:80}} />
            : <span key={i} className="tag editable-tag" onClick={()=>{setEditingTag(i);setTagVal(t)}}>{t}<button className="tag-remove" onClick={e=>{e.stopPropagation();removeTag(i)}}>x</button></span>
          )}
          {tags.length < 6 && <button className="tag-add" onClick={addTag}>+ tag</button>}
        </div>
        {(!card.sourceType||card.sourceType==='url')&&card.url&&<a href={card.url} target="_blank" rel="noopener noreferrer" className="panel-link">Open source</a>}
        {card.sourceType==='note'&&card.url&&card.suggestedSource&&<a href={card.url} target="_blank" rel="noopener noreferrer" className="panel-link panel-link--suggested">Suggested source</a>}
        {card.sourceType==='note'  &&<div className="panel-source-type">Note</div>}
        {card.sourceType==='pdf'   &&<div className="panel-source-type">PDF: {card.fileName}</div>}
        {card.sourceType==='image' &&<div className="panel-source-type">Image: {card.fileName}</div>}
        {card.sourceType==='txt'   &&<div className="panel-source-type">Text: {card.fileName}</div>}
        {card.sourceType==='md'    &&<div className="panel-source-type">Markdown: {card.fileName}</div>}
        {card.sourceType==='doc'   &&<div className="panel-source-type">Word: {card.fileName}</div>}
        <button className="delete-btn" onClick={()=>{if(window.confirm('Remove this card?'))onDelete(card.id)}}>Remove card</button>
        {connected.length > 0 && (
          <>
            <div className="panel-section-title">Connections</div>
            {connected.map(c=>(
              <div key={c.id} className="connection-item">
                <div className="connection-title">{c.title}</div>
                <div className="connection-hint">{tagOverlap(card.tags,c.tags)} shared tag{tagOverlap(card.tags,c.tags)!==1?'s':''}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function ThinkingPanel({ synthesis, synthesizing, cards, onClose, onResynthesize, onSpawnCard }) {
  const [messages, setMessages]         = useState([])
  const [chatInput, setChatInput]       = useState('')
  const [chatLoading, setChatLoading]   = useState(false)
  const [showChat, setShowChat]         = useState(false)
  const [selectionPopup, setSelectionPopup] = useState(null)
  const [showIdeas, setShowIdeas]       = useState(false)
  const [ideas, setIdeas]               = useState([])
  const [ideasLoading, setIdeasLoading] = useState(false)
  const [checkedIdeas, setCheckedIdeas] = useState({})
  const messagesEndRef = useRef(null)
  const panelRef       = useRef(null)

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    function handleMouseUp() {
      setTimeout(() => {
        const sel  = window.getSelection()
        const text = sel?.toString().trim()
        if (!text || text.length < 10) { setSelectionPopup(null); return }
        if (!panelRef.current?.contains(sel.anchorNode)) { setSelectionPopup(null); return }
        const range     = sel.getRangeAt(0)
        const rect      = range.getBoundingClientRect()
        const panelRect = panelRef.current.getBoundingClientRect()
        setSelectionPopup({ text, x: rect.left-panelRect.left+rect.width/2, y: rect.top-panelRect.top-36 })
      }, 10)
    }
    function handleMouseDown(e) { if (!e.target.closest('.selection-popup')) setSelectionPopup(null) }
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDown)
    return () => { document.removeEventListener('mouseup', handleMouseUp); document.removeEventListener('mousedown', handleMouseDown) }
  }, [])

  function buildSystemPrompt() {
    const ctx = cards.map(c=>`Card: "${c.title}" [${c.tags.join(', ')}]\nDescription: ${c.description}${c.content?`\nContent: ${c.content.slice(0,600)}`:''}` ).join('\n\n')
    return `You are a thinking partner for serious open-ended investigation. The user may be working at the frontier of any field. Your role is to think rigorously with them: follow the evidence on its own terms, steelman positions before critiquing them, identify genuine logical gaps without defaulting to consensus defense. Paradigm-challenging inquiry is how knowledge advances.\n\nBoard cards:\n${ctx}\n\nYour synthesis:\n${synthesis}\n\nBe direct and intellectually engaged. Push back on logical grounds not credibility grounds. When a new idea emerges note it as a potential new card with a suggested source. Format: "Suggested source: [name or URL]". 2-3 paragraphs max.`
  }

  async function sendMessage() {
    if (!chatInput.trim() || chatLoading) return
    const newMessages = [...messages, { role: 'user', content: chatInput }]
    setMessages(newMessages); setChatInput(''); setChatLoading(true)
    try {
      const r = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: buildSystemPrompt(), messages: newMessages })
      })
      const d = await r.json()
      setMessages(prev => [...prev, { role: 'assistant', content: d.content?.find(b=>b.type==='text')?.text||'' }])
    } catch(e) { setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]) }
    setChatLoading(false)
  }

  async function fetchIdeas(source) {
    setIdeasLoading(true); setIdeas([]); setCheckedIdeas({}); setShowIdeas(true)
    try {
      const raw = await askClaude('You identify distinct capturable ideas. Return only valid JSON.', `Text:\n\n${source.slice(0,3000)}\n\nIdentify 3-7 distinct ideas.\n\nReturn: {"ideas":[{"title":"...","summary":"1 sentence","suggestedSource":"URL or null"}]}`)
      const parsed = JSON.parse(raw.replace(/```json|```/g,'').trim())
      setIdeas(parsed.ideas||[])
      setCheckedIdeas(Object.fromEntries((parsed.ideas||[]).map((_,i)=>[i,false])))
    } catch { setIdeas([]) }
    setIdeasLoading(false)
  }

  async function spawnCheckedIdeas() {
    for (const idea of ideas.filter((_,i)=>checkedIdeas[i])) await onSpawnCard(idea.summary, idea.title, idea.suggestedSource)
    setShowIdeas(false)
  }

  return (
    <div className="synth-panel" ref={panelRef} style={{position:'relative'}}>
      <div className="synth-header">
        <span className="synth-title">Board synthesis</span>
        <div className="synth-header-actions">
          <button className="synth-icon-btn" onClick={onResynthesize} disabled={synthesizing} title="Re-synthesize">r</button>
          {synthesis && <button className={`synth-icon-btn ${showChat?'synth-icon-btn--active':''}`} onClick={()=>setShowChat(s=>!s)}>c</button>}
          <button className="close-btn" onClick={onClose}>x</button>
        </div>
      </div>
      <div className={`synth-body ${showChat?'synth-body--short':''}`}>
        {synthesizing ? <div className="synth-thinking">Thinking...</div> : (
          <>
            <div className="synth-text">{synthesis}</div>
            {synthesis && (
              <div className="synth-spawn-row">
                <button className="think-spawn-btn synth-spawn-btn" onClick={()=>onSpawnCard(synthesis)}>+ card from all</button>
                <button className="think-spawn-btn synth-spawn-btn" onClick={()=>fetchIdeas(synthesis)}>+ ideas picker</button>
              </div>
            )}
          </>
        )}
      </div>
      {showChat && synthesis && (
        <>
          <div className="think-divider"><span>Thinking environment</span></div>
          <div className="think-messages">
            {messages.length===0&&<div className="think-empty">Ask anything about this board...</div>}
            {messages.map((m,i)=>(
              <div key={i} className={`think-msg think-msg--${m.role}`}>
                <div className="think-msg-content">{m.content}</div>
                {m.role==='assistant'&&(
                  <div className="think-msg-actions">
                    <button className="think-spawn-btn" onClick={()=>onSpawnCard(m.content)}>+ card from all</button>
                    <button className="think-spawn-btn" onClick={()=>fetchIdeas(m.content)}>+ ideas picker</button>
                  </div>
                )}
              </div>
            ))}
            {chatLoading&&<div className="think-msg think-msg--assistant"><div className="think-thinking">Thinking...</div></div>}
            <div ref={messagesEndRef} />
          </div>
          <div className="think-input-bar">
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&sendMessage()} placeholder="Ask, push back, drill in..." disabled={chatLoading} className="think-input" />
            <button onClick={sendMessage} disabled={chatLoading||!chatInput.trim()} className="think-send-btn">Send</button>
          </div>
        </>
      )}
      {synthesis && (
        <div className="synth-footer">
          <button className="synth-action-btn" onClick={()=>navigator.clipboard.writeText(synthesis)}>Copy synthesis</button>
          {messages.length>0&&<button className="synth-action-btn" onClick={()=>navigator.clipboard.writeText(`# Synthesis\n\n${synthesis}\n\n# Session\n\n${messages.map(m=>`**${m.role==='user'?'You':'Liminal'}:** ${m.content}`).join('\n\n')}`)}>Export all</button>}
        </div>
      )}
      {selectionPopup&&(
        <div className="selection-popup" style={{left:selectionPopup.x,top:selectionPopup.y}}>
          <button onClick={()=>{onSpawnCard(selectionPopup.text);setSelectionPopup(null);window.getSelection()?.removeAllRanges()}}>+ card from selection</button>
        </div>
      )}
      {showIdeas&&(
        <div className="ideas-overlay" onClick={()=>setShowIdeas(false)}>
          <div className="ideas-panel" onClick={e=>e.stopPropagation()}>
            <div className="ideas-header"><span>Ideas picker</span><button className="close-btn" onClick={()=>setShowIdeas(false)}>x</button></div>
            <div className="ideas-body">
              {ideasLoading?<div className="think-thinking">Finding ideas...</div>:ideas.length===0?<div className="think-empty">No ideas found.</div>:ideas.map((idea,i)=>(
                <div key={i} className={`idea-item ${checkedIdeas[i]?'idea-item--checked':''}`} onClick={()=>setCheckedIdeas(prev=>({...prev,[i]:!prev[i]}))}>
                  <div className="idea-check">{checkedIdeas[i]?'v':''}</div>
                  <div className="idea-content">
                    <div className="idea-title">{idea.title}</div>
                    <div className="idea-summary">{idea.summary}</div>
                    {idea.suggestedSource&&<div className="idea-source">Source: {idea.suggestedSource}</div>}
                  </div>
                </div>
              ))}
            </div>
            {!ideasLoading&&ideas.length>0&&(
              <div className="ideas-footer">
                <button onClick={()=>setCheckedIdeas(Object.fromEntries(ideas.map((_,i)=>[i,true])))} className="ideas-select-all">Select all</button>
                <button onClick={spawnCheckedIdeas} disabled={!Object.values(checkedIdeas).some(Boolean)} className="ideas-spawn-btn">Spawn selected</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function Board() {
  const [cards, setCards]               = useState([])
  const [dbReady, setDbReady]           = useState(false)
  const [urlVal, setUrlVal]             = useState('')
  const [loading, setLoading]           = useState(false)
  const [pending, setPending]           = useState(null)
  const [dragging, setDragging]         = useState(null)
  const [dragOff, setDragOff]           = useState({ x: 0, y: 0 })
  const [openCard, setOpenCard]         = useState(null)
  const [synthesis, setSynthesis]       = useState('')
  const [synthesizing, setSynthesizing] = useState(false)
  const [showSynth, setShowSynth]       = useState(false)
  const [error, setError]               = useState('')
  const [status, setStatus]             = useState('')
  const [showAddModal, setShowAddModal] = useState(false)
  const [isPanning, setIsPanning]       = useState(false)

  const boardRef     = useRef(null)
  const canvasRef    = useRef(null)
  const panRef       = useRef({ x: 0, y: 0 })
  const zoomRef      = useRef(1)
  const isPanningRef = useRef(false)
  const panStartRef  = useRef({ x: 0, y: 0, px: 0, py: 0 })
  const pinchRef     = useRef(null)
  const draggedAtRef = useRef({})
  const driftRef     = useRef(null)
  const quietTicksRef= useRef(0)
  const cardsRef     = useRef([])

  useEffect(() => { cardsRef.current = cards }, [cards])

  function applyTransform() {
    if (!canvasRef.current) return
    const { x, y } = panRef.current
    const z = zoomRef.current
    canvasRef.current.style.transform = `translate(${x}px,${y}px) scale(${z})`
  }

  useEffect(() => {
    if (!dbReady || !boardRef.current) return
    const bw = boardRef.current.offsetWidth
    const bh = boardRef.current.offsetHeight
    panRef.current = { x: bw / 2 - CANVAS_CX, y: bh / 2 - CANVAS_CY }
    applyTransform()
  }, [dbReady])

  function toCanvasSpace(cards) {
    return cards.map(c => {
      if (c.canvasSpace) return c
      return { ...c, x: CANVAS_CX - 600 + (c.x||0), y: CANVAS_CY - 350 + (c.y||0), canvasSpace: true }
    })
  }

  useEffect(() => {
    async function init() {
      setStatus('Loading board...')
      try {
        const res = await workerFetch('/cards')
        if (res.ok) {
          const data = await res.json()
          if (data.cards && data.cards.length > 0) {
            setCards(toCanvasSpace(data.cards)); setDbReady(true); setStatus(''); return
          }
        }
        const raw = localStorage.getItem('liminal-cards')
        if (raw) {
          const oldCards = JSON.parse(raw)
          if (oldCards.length > 0) {
            setStatus('Migrating cards...')
            const migrated = toCanvasSpace(oldCards.map((c,i)=>({...c, id:crypto.randomUUID(), accentIndex:i%8})))
            await Promise.all(migrated.map(card=>workerFetch(`/card/${card.id}`,'PUT',card)))
            localStorage.removeItem('liminal-cards')
            setCards(migrated)
          }
        }
        setDbReady(true); setStatus('')
      } catch (e) {
        console.error('[Liminal] Init failed:', e)
        try { const raw=localStorage.getItem('liminal-cards'); if(raw) setCards(JSON.parse(raw)) } catch {}
        setDbReady(true); setStatus('')
        setError(`Worker unavailable. (${e.message})`)
      }
    }
    init()
  }, [])

  useEffect(() => {
    const board = boardRef.current
    if (!board) return
    const handleWheel = e => {
      e.preventDefault()
      const br  = board.getBoundingClientRect()
      const cx  = e.clientX - br.left
      const cy  = e.clientY - br.top
      const oldZ = zoomRef.current
      const newZ = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, oldZ * (e.deltaY > 0 ? 1-ZOOM_STEP : 1+ZOOM_STEP)))
      panRef.current = { x: cx-(cx-panRef.current.x)*(newZ/oldZ), y: cy-(cy-panRef.current.y)*(newZ/oldZ) }
      zoomRef.current = newZ
      applyTransform()
    }
    board.addEventListener('wheel', handleWheel, { passive: false })
    return () => board.removeEventListener('wheel', handleWheel)
  }, [])

  const QUIET_TICKS_TO_STOP = 8
  const SETTLE_THRESHOLD    = 0.3

  function stopDrift() {
    if (driftRef.current) {
      clearInterval(driftRef.current); driftRef.current = null
      if (dbReady && cardsRef.current.length > 0)
        workerFetch('/cards/batch','POST',{cards:cardsRef.current}).catch(e=>console.error('[Liminal] Batch save:',e))
    }
    quietTicksRef.current = 0
  }

  function startDrift() {
    stopDrift()
    setCards(prev => {
      let moved=true, result=[...prev], passes=0
      while (moved && passes<20) {
        moved=false; passes++
        result=result.map(card => {
          let fx=0,fy=0
          result.forEach(other => {
            if(other.id===card.id)return
            const dx=other.x-card.x,dy=other.y-card.y,dist=Math.sqrt(dx*dx+dy*dy)||1
            if(dist<REPEL_DIST){const push=(REPEL_DIST-dist)+2;fx-=(dx/dist)*push;fy-=(dy/dist)*push}
          })
          if(Math.abs(fx)<0.5&&Math.abs(fy)<0.5)return card
          moved=true
          return {...card,x:Math.max(0,Math.min(CANVAS_W-CARD_W,card.x+fx)),y:Math.max(0,Math.min(CANVAS_H-CARD_H,card.y+fy))}
        })
      }
      return result
    })
    driftRef.current = setInterval(() => {
      const now=Date.now(); let maxMove=0
      setCards(prev => {
        const next=prev.map(card => {
          if(draggedAtRef.current[card.id]&&now-draggedAtRef.current[card.id]<DRAG_PAUSE)return card
          let fx=0,fy=0
          prev.forEach(other => {
            if(other.id===card.id)return
            const dx=other.x-card.x,dy=other.y-card.y,dist=Math.sqrt(dx*dx+dy*dy)||1
            const overlap=tagOverlap(card.tags,other.tags)
            if(overlap>0&&dist>ATTRACT_DIST){const s=overlap*DRIFT_SPEED/dist;fx+=dx*s;fy+=dy*s}
            if(dist<CARD_W){const push=(CARD_W-dist)*0.15;fx-=(dx/dist)*push;fy-=(dy/dist)*push}
          })
          const fmag=Math.sqrt(fx*fx+fy*fy)
          if(fmag<SETTLE_THRESHOLD)return card
          const capped=Math.min(fmag,MAX_MOVE)
          const mx=(fx/fmag)*capped,my=(fy/fmag)*capped
          maxMove=Math.max(maxMove,capped)
          return {...card,x:Math.max(0,Math.min(CANVAS_W-CARD_W,card.x+mx)),y:Math.max(0,Math.min(CANVAS_H-CARD_H,card.y+my))}
        })
        if(maxMove<SETTLE_THRESHOLD){quietTicksRef.current+=1;if(quietTicksRef.current>=QUIET_TICKS_TO_STOP){stopDrift();return prev}}else{quietTicksRef.current=0}
        return next
      })
    }, DRIFT_INTERVAL)
  }

  useEffect(() => {
    if (cards.length >= 2) startDrift()
    return () => stopDrift()
  }, [cards.map(c=>`${c.id}:${c.tags.join(',')}`).join('|')])

  function handleBoardPointerDown(e) {
    if (e.target.closest('.card')) return
    if (e.button !== undefined && e.button !== 0) return
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    isPanningRef.current = true; setIsPanning(true)
    panStartRef.current = { x: clientX, y: clientY, px: panRef.current.x, py: panRef.current.y }
    e.preventDefault()
  }

  function handleBoardTouchStart(e) {
    if (e.target.closest('.card')) return
    if (e.touches.length === 2) {
      const t1=e.touches[0],t2=e.touches[1]
      isPanningRef.current = false
      pinchRef.current = {
        dist: Math.hypot(t2.clientX-t1.clientX, t2.clientY-t1.clientY),
        zoom: zoomRef.current,
        px: panRef.current.x, py: panRef.current.y,
        cx: (t1.clientX+t2.clientX)/2, cy: (t1.clientY+t2.clientY)/2,
      }
      e.preventDefault(); return
    }
    handleBoardPointerDown(e)
  }

  function startDrag(e, id) {
    if (e.target.closest('[data-actions]')) return
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    const br = boardRef.current?.getBoundingClientRect()
    if (!br) return
    const canvasX = (clientX-br.left-panRef.current.x) / zoomRef.current
    const canvasY = (clientY-br.top-panRef.current.y)  / zoomRef.current
    const card = cards.find(c=>c.id===id)
    if (!card) return
    setDragging(id)
    setDragOff({ x: canvasX-card.x, y: canvasY-card.y })
    draggedAtRef.current[id] = Date.now()
    isPanningRef.current = false; setIsPanning(false)
    e.preventDefault(); e.stopPropagation()
  }

  useEffect(() => {
    const getClient = e => ({ clientX: e.touches?e.touches[0].clientX:e.clientX, clientY: e.touches?e.touches[0].clientY:e.clientY })

    const handleMove = e => {
      if (dragging) {
        const br = boardRef.current?.getBoundingClientRect(); if(!br)return
        const {clientX,clientY} = getClient(e)
        const canvasX = (clientX-br.left-panRef.current.x)/zoomRef.current
        const canvasY = (clientY-br.top-panRef.current.y)/zoomRef.current
        const x=Math.max(0,Math.min(CANVAS_W-CARD_W,canvasX-dragOff.x))
        const y=Math.max(0,Math.min(CANVAS_H-CARD_H,canvasY-dragOff.y))
        setCards(p=>p.map(c=>c.id===dragging?{...c,x,y}:c)); return
      }
      if (isPanningRef.current) {
        const {clientX,clientY} = getClient(e)
        panRef.current = { x: panStartRef.current.px+(clientX-panStartRef.current.x), y: panStartRef.current.py+(clientY-panStartRef.current.y) }
        applyTransform()
      }
    }

    const handleTouchMove = e => {
      if (e.touches.length===2 && pinchRef.current) {
        e.preventDefault()
        const t1=e.touches[0],t2=e.touches[1]
        const dist=Math.hypot(t2.clientX-t1.clientX,t2.clientY-t1.clientY)
        const scale=dist/pinchRef.current.dist
        const newZ=Math.max(ZOOM_MIN,Math.min(ZOOM_MAX,pinchRef.current.zoom*scale))
        const br=boardRef.current?.getBoundingClientRect(); if(!br)return
        const cx=pinchRef.current.cx-br.left, cy=pinchRef.current.cy-br.top
        panRef.current = { x: cx-(cx-pinchRef.current.px)*(newZ/pinchRef.current.zoom), y: cy-(cy-pinchRef.current.py)*(newZ/pinchRef.current.zoom) }
        zoomRef.current=newZ; applyTransform(); return
      }
      handleMove(e)
    }

    const handleEnd = () => {
      if (dragging) { draggedAtRef.current[dragging]=Date.now(); setTimeout(()=>startDrift(),DRAG_PAUSE); setDragging(null) }
      if (isPanningRef.current) { isPanningRef.current=false; setIsPanning(false) }
      pinchRef.current=null
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup',   handleEnd)
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend',  handleEnd)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup',   handleEnd)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend',  handleEnd)
    }
  }, [dragging, dragOff])

  async function handleAdd() {
    if (!urlVal.trim()||loading) return
    const u=urlVal.trim(); setUrlVal(''); setLoading(true); setError(''); setStatus('Reading...')
    try {
      const raw  = await askClaude('You extract metadata from URLs. Return only valid JSON.', `URL: ${u}\n\nReturn: {"title":"concise title max 60 chars","tags":["tag1","tag2"],"description":"1-2 sentence summary"}`)
      const meta = JSON.parse(raw.replace(/```json|```/g,'').trim())
      setStatus(''); setPending({ url: u, ...meta })
    } catch (e) { setError(e.message||String(e)); setStatus('') }
    setLoading(false)
  }

  function confirmCard(tags) {
    let x,y,attempts=0
    do {
      x=CANVAS_CX-250+Math.random()*500; y=CANVAS_CY-200+Math.random()*400; attempts++
    } while (attempts<30 && cards.some(c=>Math.sqrt((c.x-x)**2+(c.y-y)**2)<REPEL_DIST))
    const newCard = { id:crypto.randomUUID(), accentIndex:Math.floor(Math.random()*ACCENTS.length), ...pending, tags, x, y, canvasSpace:true }
    setCards(prev=>[...prev,newCard]); setPending(null)
    workerFetch(`/card/${newCard.id}`,'PUT',newCard).catch(e=>console.error('[Liminal] Save card:',e))
  }

  function updateCard(id, updates) {
    let updated=null
    setCards(prev=>prev.map(c=>{if(c.id===id){updated={...c,...updates};return updated}return c}))
    if(openCard?.id===id)setOpenCard(prev=>({...prev,...updates}))
    if(updated)workerFetch(`/card/${id}`,'PUT',updated).catch(e=>console.error('[Liminal] Update card:',e))
  }

  function deleteCard(id) {
    setCards(prev=>prev.filter(c=>c.id!==id)); setOpenCard(null)
    workerFetch(`/card/${id}`,'DELETE').catch(e=>console.error('[Liminal] Delete card:',e))
  }

  async function spawnCardFromText(text, presetTitle, presetUrl) {
    setStatus('Creating card from insight...')
    try {
      const raw  = await askClaude('You extract metadata from text. Return only valid JSON.', `Text:\n\n${text.slice(0,2000)}\n\nReturn: {"title":"concise title max 60 chars","tags":["tag1","tag2"],"description":"1-2 sentence summary","suggestedUrl":"URL or null"}`)
      const meta = JSON.parse(raw.replace(/```json|```/g,'').trim())
      const {suggestedUrl,...rest}=meta
      setStatus(''); setPending({ sourceType:'note', content:text, url:presetUrl||suggestedUrl||null, suggestedSource:true, ...rest, ...(presetTitle?{title:presetTitle}:{}) })
    } catch(e) { setError(e.message||String(e)); setStatus('') }
  }

  async function synthesize() {
    if(!cards.length)return
    setSynthesizing(true); setShowSynth(true); setSynthesis(''); setError('')
    const summary=cards.map(c=>`"${c.title}" [${c.tags.join(', ')}] -- ${c.description}`).join('\n')
    try {
      const r=await askClaude('You are a synthesis engine for Liminal. Find the emergent pattern in curated knowledge. Steelman the research program. Surface non-obvious connections. What is the board building toward? Distinguish documented evidence, logical inference, and speculative extension. 3 paragraphs max.',`Board:\n\n${summary}\n\nWhat is the emergent pattern?`)
      setSynthesis(r)
    } catch(e){setError(e.message||String(e))}
    setSynthesizing(false)
  }

  return (
    <div className="liminal">
      <div className="toolbar">
        <span className="brand">Liminal</span>
        <input value={urlVal} onChange={e=>setUrlVal(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleAdd()} placeholder="Paste a URL to add an idea..." disabled={loading||!dbReady} />
        <button onClick={handleAdd} disabled={loading||!urlVal.trim()||!dbReady}>{loading?'Reading...':'Add'}</button>
        <button className="btn-add-more" onClick={()=>setShowAddModal(true)} disabled={loading||!dbReady}>+ Note / PDF / Image</button>
        <button className="btn-synth" onClick={synthesize} disabled={synthesizing||cards.length===0}>{synthesizing?'Thinking...':'Synthesize'}</button>
      </div>

      {status&&<div className="status-bar">{status}</div>}
      {error&&<div className="error-bar"><strong>Error:</strong> {error}<button onClick={()=>setError('')}>dismiss</button></div>}
      {pending&&<TagConfirm pending={pending} onConfirm={confirmCard} onDiscard={()=>setPending(null)} />}

      <div className="main-area">
        <div
          className={`board${isPanning?' board--panning':''}`}
          ref={boardRef}
          onMouseDown={handleBoardPointerDown}
          onTouchStart={handleBoardTouchStart}
        >
          {!dbReady&&<div className="empty"><span>Loading board...</span></div>}
          {dbReady&&cards.length===0&&!pending&&<div className="empty"><span>Paste a URL above to place your first idea</span></div>}

          <div className="canvas" ref={canvasRef} style={{width:CANVAS_W,height:CANVAS_H}}>
            {cards.map(card=>(
              <LiminalCard key={card.id} card={card} isDragging={dragging===card.id} onDragStart={startDrag} onDetail={()=>setOpenCard(card)} />
            ))}
          </div>

          {openCard&&<DetailPanel card={openCard} cards={cards} onClose={()=>setOpenCard(null)} onUpdate={updateCard} onDelete={deleteCard} />}
        </div>

        {showSynth&&<ThinkingPanel synthesis={synthesis} synthesizing={synthesizing} cards={cards} onClose={()=>setShowSynth(false)} onResynthesize={synthesize} onSpawnCard={spawnCardFromText} />}
      </div>

      {showAddModal&&<AddModal onClose={()=>setShowAddModal(false)} onPending={setPending} setError={setError} setStatus={setStatus} />}
    </div>
  )
}
