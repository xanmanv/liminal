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

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; magA += a[i]*a[i]; magB += b[i]*b[i] }
  const mag = Math.sqrt(magA) * Math.sqrt(magB)
  return mag ? dot / mag : 0
}

function LiminalCard({ card, isDragging, onDragStart, onDetail, isSelected, onToggleSelect }) {
  const ac = ACCENTS[card.accentIndex ?? 0]
  return (
    <div
      className={`card ${isDragging ? 'card--dragging' : ''} ${isSelected ? 'card--selected' : ''}`}
      onMouseDown={e => onDragStart(e, card.id)}
      onTouchStart={e => onDragStart(e, card.id)}
      style={{ left: card.x, top: card.y }}
    >
      <div className="card-header" style={{ background: ac.bg }}>
        <input
          type="checkbox"
          className="card-checkbox"
          checked={isSelected}
          onChange={e => { e.stopPropagation(); onToggleSelect(card.id) }}
          onMouseDown={e => e.stopPropagation()}
          onTouchStart={e => e.stopPropagation()}
        />
        <span style={{ color: ac.text }}>{card.title.slice(0, 50)}{card.title.length > 50 ? '…' : ''}</span>
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
  const removeTag = (i) => setTags(t => t.filter((_, idx) => idx !== i))
  const addTag    = () => { if (tags.length >= 6) return; setTags(t => [...t, '']) }
  return (
    <div className="confirm-bar">
      <span className="confirm-title">"{pending.title.slice(0, 32)}{pending.title.length > 32 ? '…' : ''}"</span>
      <span className="confirm-label">Tags:</span>
      {tags.map((t, i) => (
        <span key={i} className="confirm-tag-wrap">
          <input value={t} onChange={e => updateTag(i, e.target.value)} className="tag-input" autoFocus={t === ''} />
          <button className="confirm-tag-remove" onClick={() => removeTag(i)} title="Remove tag">×</button>
        </span>
      ))}
      {tags.length < 6 && <button className="confirm-tag-add" onClick={addTag}>+ tag</button>}
      <button onClick={() => onConfirm(tags.filter(t => t.trim()))}>Add to board</button>
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
  const [editDesc, setEditDesc]     = useState(false)
  const [descVal, setDescVal]       = useState(card.description || '')
  const [tags, setTags]             = useState([...card.tags])
  const [editingTag, setEditingTag] = useState(null)
  const [tagVal, setTagVal]         = useState('')

  function saveTitle() { onUpdate(card.id, { title: titleVal }); setEditTitle(false) }
  function saveDesc()  { onUpdate(card.id, { description: descVal }); setEditDesc(false) }
  function saveTag(i)  { const n=[...tags]; n[i]=tagVal; setTags(n); onUpdate(card.id,{tags:n}); setEditingTag(null) }
  function removeTag(i){ const n=tags.filter((_,idx)=>idx!==i); setTags(n); onUpdate(card.id,{tags:n}) }
  function addTag()    { if(tags.length>=6)return; const n=[...tags,'']; setTags(n); setEditingTag(n.length-1); setTagVal('') }
  const connected = cards
    .filter(c => c.id !== card.id && card.embedding && c.embedding)
    .map(c => ({ ...c, similarity: cosineSimilarity(card.embedding, c.embedding) }))
    .filter(c => c.similarity > 0.75)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 8)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}>
        <div className="panel-header">
          <span>Idea detail</span>
          <button className="close-btn" onClick={onClose}>x</button>
        </div>
        {editTitle
          ? <input autoFocus value={titleVal} onChange={e=>setTitleVal(e.target.value)} onBlur={saveTitle} onKeyDown={e=>e.key==='Enter'&&saveTitle()} className="edit-title-input" />
          : <div className="panel-title editable" onClick={()=>setEditTitle(true)}>{card.title} <span className="edit-hint">e</span></div>
        }
        {editDesc
          ? <div className="edit-desc-wrap">
              <textarea autoFocus value={descVal}
                onChange={e=>setDescVal(e.target.value)}
                onInput={e=>{e.target.style.height='auto';e.target.style.height=e.target.scrollHeight+'px'}}
                onKeyDown={e=>{if(e.key==='Escape')saveDesc();if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))saveDesc()}}
                className="edit-desc-textarea"
                ref={el=>{if(el){el.style.height='auto';el.style.height=el.scrollHeight+'px'}}}
              />
              <div className="edit-desc-actions">
                <span className="edit-desc-hint">Ctrl+Enter to save</span>
                <button className="edit-desc-save" onMouseDown={e=>{e.preventDefault();saveDesc()}}>Save</button>
              </div>
            </div>
          : <div className="panel-desc editable" onClick={()=>setEditDesc(true)}>{card.description || <span className="edit-hint-muted">Click to add description</span>} <span className="edit-hint">e</span></div>
        }
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
                <div className="connection-hint">{Math.round(c.similarity*100)}% similar</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function ThinkingPanel({ synthesis, synthesizing, cards, onClose, onResynthesize, onSpawnCard, onSaveToResearch }) {
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
        <button className="queue-back-btn" onClick={onClose}>← Board</button>
        <span className="synth-title">Board synthesis</span>
        <div className="synth-header-actions">
          <button className="synth-icon-btn" onClick={onResynthesize} disabled={synthesizing} title="Re-synthesize">r</button>
          {synthesis && <button className={`synth-icon-btn ${showChat?'synth-icon-btn--active':''}`} onClick={()=>setShowChat(s=>!s)} title="Open thinking environment">c</button>}
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
          <button className="synth-action-btn" onClick={()=>navigator.clipboard.writeText(synthesis)}>Copy</button>
          {messages.length>0&&<button className="synth-action-btn" onClick={()=>navigator.clipboard.writeText(`# Synthesis\n\n${synthesis}\n\n# Session\n\n${messages.map(m=>`**${m.role==='user'?'You':'Liminal'}:** ${m.content}`).join('\n\n')}`)}>Export</button>}
          <button className="synth-save-btn" onClick={onSaveToResearch}>Save to Queue</button>
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

// ── ResearchQueuePanel ────────────────────────────────────────────────────────
// Slides in from the right alongside the board.
// Shows all saved synthesis events as a browseable list.

const FLAG_COLORS = { Research: '#4f6ef7', Hold: '#D97706', Publish: '#16A34A', Watch: '#9333EA' }
const PRIORITY_COLORS = { High: '#f87171', Medium: '#D97706', Background: '#4a5068' }

function ResearchQueuePanel({ events, cards, onClose, onOpenEvent }) {
  const sorted = [...events].sort((a,b) => new Date(b.created) - new Date(a.created))

  function firstLine(text) {
    if (!text) return ''
    const line = text.split('\n')[0].slice(0, 130)
    return line.length < text.length ? line + '…' : line
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="queue-panel">
      <div className="queue-header">
        <button className="queue-back-btn" onClick={onClose}>← Board</button>
        <span className="queue-title">Research Queue</span>
        {events.length > 0 && <span className="queue-count">{events.length}</span>}
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      <div className="queue-body">
        {sorted.length === 0 ? (
          <div className="queue-empty">No synthesis events saved yet. Synthesize a board and hit "Save to Queue".</div>
        ) : sorted.map(event => (
          <div key={event.id} className="queue-item" onClick={() => onOpenEvent(event)}>
            <div className="queue-item-flags">
              {event.actionFlag && (
                <span className="queue-flag" style={{ color: FLAG_COLORS[event.actionFlag] || '#7b8ef7' }}>{event.actionFlag}</span>
              )}
              {event.priority && (
                <span className="queue-priority" style={{ color: PRIORITY_COLORS[event.priority] || '#4a5068' }}>{event.priority}</span>
              )}
              {event.project && event.project !== 'General' && (
                <span className="queue-project">{event.project}</span>
              )}
            </div>
            <div className="queue-item-text">{firstLine(event.synthesisText)}</div>
            {event.derivedQuestions?.length > 0 && (
              <div className="queue-item-questions">
                {event.derivedQuestions.slice(0, 2).map((q, i) => (
                  <div key={i} className="queue-item-q">— {q}</div>
                ))}
                {event.derivedQuestions.length > 2 && (
                  <div className="queue-item-q-more">+{event.derivedQuestions.length - 2} more</div>
                )}
              </div>
            )}
            <div className="queue-item-meta">
              <span className="queue-date">{formatDate(event.created)}</span>
              {event.sourceCardIds?.length > 0 && (
                <span className="queue-cards">{event.sourceCardIds.length} card{event.sourceCardIds.length !== 1 ? 's' : ''}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── EventDetailOverlay ────────────────────────────────────────────────────────
// Full reading and editing view for a saved synthesis event.
// Opens on top of everything when a queue item is clicked.

function EventDetailOverlay({ event, cards, onClose, onUpdate, onDelete }) {
  const [synthesisText, setSynthesisText] = useState(event.synthesisText || '')
  const [questions, setQuestions]         = useState([...(event.derivedQuestions || [])])
  const [annotation, setAnnotation]       = useState(event.annotation || '')
  const [actionFlag, setActionFlag]       = useState(event.actionFlag || 'Research')
  const [priority, setPriority]           = useState(event.priority || 'High')
  const [project, setProject]             = useState(event.project || 'General')
  const [newQuestion, setNewQuestion]     = useState('')
  const [saving, setSaving]               = useState(false)
  const [dirty, setDirty]                 = useState(false)
  const scrollBodyRef                     = useRef(null)

  // Prevent iOS rubber band bounce on the scroll container
  useEffect(() => {
    const el = scrollBodyRef.current
    if (!el) return
    let startY = 0
    const onTouchStart = e => { startY = e.touches[0].clientY }
    const onTouchMove = e => {
      const scrollTop = el.scrollTop
      const maxScroll = el.scrollHeight - el.clientHeight
      // Only prevent if there's no scrollable content at all
      if (maxScroll <= 0) e.preventDefault()
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  const sourceCards = cards.filter(c => event.sourceCardIds?.includes(c.id))

  function addQuestion() {
    if (!newQuestion.trim()) return
    setQuestions(prev => [...prev, newQuestion.trim()])
    setNewQuestion('')
    setDirty(true)
  }

  function removeQuestion(i) {
    setQuestions(prev => prev.filter((_, idx) => idx !== i))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    await onUpdate({
      ...event,
      synthesisText,
      derivedQuestions: questions,
      annotation,
      actionFlag,
      priority,
      project,
      modified: new Date().toISOString(),
    })
    setSaving(false)
    setDirty(false)
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  return (
    <div className="event-overlay" onClick={onClose}>
      <div className="event-panel" onClick={e => e.stopPropagation()}>

        <div className="event-header">
          <div className="event-header-meta">
            <button className="queue-back-btn" onClick={onClose}>← Queue</button>
            <span className="event-date">{formatDate(event.created)}</span>
            {event.model && <span className="event-model">{event.model.includes('opus') ? 'Opus' : 'Sonnet'}</span>}
          </div>
          <div className="event-header-actions">
            {dirty && (
              <button className="event-save-btn" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save changes'}
              </button>
            )}
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="event-body" ref={scrollBodyRef}>

          {/* Left column */}
          <div className="event-left">

            <div className="capture-section-label">Action</div>
            <div className="capture-flags">
              {ACTION_FLAGS.map(f => (
                <button key={f} className={`capture-flag ${actionFlag===f?'capture-flag--active':''}`}
                  onClick={() => { setActionFlag(f); setDirty(true) }}>{f}</button>
              ))}
            </div>

            <div className="capture-section-label">Priority</div>
            <div className="capture-flags">
              {PRIORITIES.map(p => (
                <button key={p} className={`capture-flag ${priority===p?'capture-flag--active':''}`}
                  onClick={() => { setPriority(p); setDirty(true) }}>{p}</button>
              ))}
            </div>

            <div className="capture-section-label">Project</div>
            <select className="capture-select" value={project} onChange={e => { setProject(e.target.value); setDirty(true) }}>
              {PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>

            {sourceCards.length > 0 && (
              <>
                <div className="capture-section-label">Source cards</div>
                <div className="capture-source-cards">
                  {sourceCards.map(c => <div key={c.id} className="capture-source-card">{c.title}</div>)}
                </div>
              </>
            )}

            <div className="capture-section-label">Annotation</div>
            <textarea
              className="capture-annotation"
              placeholder="Your note on what matters here..."
              value={annotation}
              onChange={e => { setAnnotation(e.target.value); setDirty(true) }}
            />

            <button className="event-delete-btn" onClick={() => {
              if (window.confirm('Delete this synthesis event? This cannot be undone.')) onDelete(event.id)
            }}>Delete event</button>

          </div>

          {/* Right column */}
          <div className="event-right">

            <div className="capture-section-label">Synthesis</div>
            <textarea
              className="capture-synthesis"
              value={synthesisText}
              onChange={e => { setSynthesisText(e.target.value); setDirty(true) }}
            />

            <div className="capture-section-label">Derived questions</div>
            <div className="capture-questions">
              {questions.map((q, i) => (
                <div key={i} className="capture-question">
                  <span className="capture-question-text">{q}</span>
                  <button className="capture-q-remove" onClick={() => removeQuestion(i)}>×</button>
                </div>
              ))}
              <div className="capture-q-row">
                <input
                  className="capture-q-input"
                  placeholder="Add a question... (Enter)"
                  value={newQuestion}
                  onChange={e => setNewQuestion(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addQuestion()}
                />
                <button className="capture-q-add" onClick={addQuestion}>Add</button>
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

// ── SynthesisCapturePanel ─────────────────────────────────────────────────────
// Editable save interface for synthesis events.
// The human verification pass — what gets saved is co-authored, not raw output.

const ACTION_FLAGS = ['Research', 'Hold', 'Publish', 'Watch']
const PRIORITIES   = ['High', 'Medium', 'Background']
const PROJECTS     = ['General', 'EP03', 'Liminal', 'CarrierWave']

function SynthesisCapturePanel({ synthesis, sourceCardIds, cards, onSave, onClose }) {
  const [synthesisText, setSynthesisText] = useState(synthesis)
  const [questions, setQuestions]         = useState([])
  const [newQuestion, setNewQuestion]     = useState('')
  const [annotation, setAnnotation]       = useState('')
  const [actionFlag, setActionFlag]       = useState('Research')
  const [priority, setPriority]           = useState('High')
  const [project, setProject]             = useState('General')
  const [saving, setSaving]               = useState(false)

  const sourceCards = cards.filter(c => sourceCardIds.includes(c.id))

  function addQuestion() {
    if (!newQuestion.trim()) return
    setQuestions(prev => [...prev, newQuestion.trim()])
    setNewQuestion('')
  }

  function removeQuestion(i) {
    setQuestions(prev => prev.filter((_, idx) => idx !== i))
  }

  async function handleSave() {
    if (!synthesisText.trim()) return
    setSaving(true)
    const event = {
      id:               crypto.randomUUID(),
      type:             'synthesis_event',
      created:          new Date().toISOString(),
      modified:         new Date().toISOString(),
      sourceCardIds:    sourceCardIds,
      synthesisText:    synthesisText.trim(),
      derivedQuestions: questions,
      annotation:       annotation.trim(),
      actionFlag,
      priority,
      project,
      linkedIds:        [],
      status:           'active',
      model:            'claude-sonnet-4-6',
    }
    await onSave(event)
    setSaving(false)
  }

  return (
    <div className="capture-overlay" onClick={onClose}>
      <div className="capture-panel" onClick={e => e.stopPropagation()}>

        <div className="capture-header">
          <span className="capture-title">Save to Research Queue</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="capture-body">

          {/* Left column — metadata */}
          <div className="capture-left">

            <div className="capture-section-label">Action</div>
            <div className="capture-flags">
              {ACTION_FLAGS.map(f => (
                <button key={f} className={`capture-flag ${actionFlag===f?'capture-flag--active':''}`} onClick={() => setActionFlag(f)}>{f}</button>
              ))}
            </div>

            <div className="capture-section-label">Priority</div>
            <div className="capture-flags">
              {PRIORITIES.map(p => (
                <button key={p} className={`capture-flag ${priority===p?'capture-flag--active':''}`} onClick={() => setPriority(p)}>{p}</button>
              ))}
            </div>

            <div className="capture-section-label">Project</div>
            <select className="capture-select" value={project} onChange={e => setProject(e.target.value)}>
              {PROJECTS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>

            <div className="capture-section-label">Your annotation</div>
            <textarea
              className="capture-annotation"
              placeholder="What strikes you most? What is the most significant thread here?"
              value={annotation}
              onChange={e => setAnnotation(e.target.value)}
            />

            <div className="capture-section-label">Source cards</div>
            <div className="capture-source-cards">
              {sourceCards.length === 0
                ? <div className="capture-source-all">All board cards</div>
                : sourceCards.map(c => <div key={c.id} className="capture-source-card">{c.title}</div>)
              }
            </div>

          </div>

          {/* Right column — synthesis + questions */}
          <div className="capture-right">

            <div className="capture-section-label">Synthesis <span className="capture-edit-hint">— edit to hone before saving</span></div>
            <textarea
              className="capture-synthesis"
              value={synthesisText}
              onChange={e => setSynthesisText(e.target.value)}
            />

            <div className="capture-section-label">Derived questions</div>
            <div className="capture-questions">
              {questions.map((q, i) => (
                <div key={i} className="capture-question">
                  <span className="capture-question-text">{q}</span>
                  <button className="capture-q-remove" onClick={() => removeQuestion(i)}>×</button>
                </div>
              ))}
              <div className="capture-q-row">
                <input
                  className="capture-q-input"
                  placeholder="Add a research question this raised... (Enter to add)"
                  value={newQuestion}
                  onChange={e => setNewQuestion(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addQuestion()}
                />
                <button className="capture-q-add" onClick={addQuestion}>Add</button>
              </div>
            </div>

          </div>
        </div>

        <div className="capture-footer">
          <button className="capture-cancel" onClick={onClose}>Cancel</button>
          <button className="capture-save" onClick={handleSave} disabled={saving || !synthesisText.trim()}>
            {saving ? 'Saving...' : 'Save to Research Queue'}
          </button>
        </div>

      </div>
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
  const [showCapture, setShowCapture]   = useState(false)
  const [events, setEvents]             = useState([])
  const [showQueue, setShowQueue]       = useState(false)
  const [openEvent, setOpenEvent]       = useState(null)
  const [selectedCardIds, setSelectedCardIds] = useState([])

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
            setCards(toCanvasSpace(data.cards)); setDbReady(true); setStatus('')
            // Load events alongside cards
            workerFetch('/events').then(r => r.ok ? r.json() : { events: [] }).then(d => {
              if (d.events?.length) setEvents(d.events)
            }).catch(() => {})
            return
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
        // Load events in background
        workerFetch('/events').then(r => r.ok ? r.json() : { events: [] }).then(d => {
          if (d.events?.length) setEvents(d.events)
        }).catch(() => {})
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
      if (e.target.closest('.panel, .synth-panel, .queue-panel, .capture-panel, .event-panel, .ideas-panel')) return
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
            const sim=cosineSimilarity(card.embedding,other.embedding)
            if(sim>0.75&&dist>ATTRACT_DIST){const s=sim*DRIFT_SPEED/dist;fx+=dx*s;fy+=dy*s}
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
    if (!urlVal.trim() || loading) return
    const u = urlVal.trim()
    setUrlVal(''); setLoading(true); setError(''); setStatus('Fetching page...')
    try {
      // Step 1: Try to fetch page content via CORS proxy
      let pageText = ''
      try {
        const proxyRes = await fetch(
          `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
          { signal: AbortSignal.timeout(8000) }
        )
        if (proxyRes.ok) {
          const proxyData = await proxyRes.json()
          const parser = new DOMParser()
          const doc = parser.parseFromString(proxyData.contents || '', 'text/html')
          doc.querySelectorAll('script, style, nav, header, footer, aside').forEach(el => el.remove())
          pageText = (doc.body?.innerText || doc.body?.textContent || '')
            .replace(/\s+/g, ' ').trim().slice(0, 6000)
        }
      } catch {
        // Proxy failed or timed out — fall through to URL-only mode
      }

      setStatus('Reading...')

      const prompt = pageText
        ? `URL: ${u}\n\nPage content:\n${pageText}\n\nReturn: {"title":"concise title max 60 chars","tags":["tag1","tag2","tag3"],"description":"1-2 sentence summary"}`
        : `URL: ${u}\n\nPage content could not be fetched. Infer from the URL structure alone.\n\nReturn: {"title":"concise title max 60 chars","tags":["tag1","tag2","tag3"],"description":"1-2 sentence summary"}`

      const raw = await askClaude(
        'You extract metadata from web pages. You MUST return ONLY a valid JSON object — no preamble, no explanation, no markdown fences, no conversational text. Even if you cannot access the URL, infer from it and return JSON.',
        prompt
      )

      const meta = JSON.parse(raw.replace(/```json|```/g, '').trim())
      setStatus('')
      setPending({ url: u, ...meta })
    } catch (e) {
      setError(e.message || String(e))
      setStatus('')
    }
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

  // Save synthesis event to Research Queue
  async function saveEvent(event) {
    setEvents(prev => [...prev, event])
    setShowCapture(false)
    try {
      await workerFetch(`/event/${event.id}`, 'PUT', event)
      setStatus('Saved to Research Queue')
      setTimeout(() => setStatus(''), 2000)
    } catch (e) {
      console.error('[Liminal] Save event failed:', e)
      setError(`Failed to save: ${e.message}`)
    }
  }

  async function updateEvent(updated) {
    setEvents(prev => prev.map(e => e.id === updated.id ? updated : e))
    setOpenEvent(updated)
    try {
      await workerFetch(`/event/${updated.id}`, 'PUT', updated)
      setStatus('Event updated')
      setTimeout(() => setStatus(''), 1500)
    } catch (e) {
      console.error('[Liminal] Update event failed:', e)
      setError(`Failed to update: ${e.message}`)
    }
  }

  async function deleteEventItem(id) {
    setEvents(prev => prev.filter(e => e.id !== id))
    setOpenEvent(null)
    workerFetch(`/event/${id}`, 'DELETE').catch(e => console.error('[Liminal] Delete event:', e))
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

  function toggleCardSelection(id) {
    setSelectedCardIds(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    )
  }

  async function synthesize(cardSubset) {
    const targetCards = cardSubset || cards
    if (!targetCards.length) return
    setSynthesizing(true); setShowSynth(true); setSynthesis(''); setError('')
    const summary = targetCards.map(c => `"${c.title}" [${c.tags.join(', ')}] -- ${c.description}`).join('\n')
    try {
      const r = await askClaude(
        'You are a synthesis engine for Liminal. Find the emergent pattern in curated knowledge. Steelman the research program. Surface non-obvious connections. What is the board building toward? Distinguish documented evidence, logical inference, and speculative extension. 3 paragraphs max.',
        `Board:\n\n${summary}\n\nWhat is the emergent pattern?`
      )
      setSynthesis(r)
    } catch(e) { setError(e.message || String(e)) }
    setSynthesizing(false)
  }

  return (
    <div className="liminal">
      <div className="toolbar">
        <span className="brand">Liminal</span>
        <input value={urlVal} onChange={e=>setUrlVal(e.target.value)} onKeyDown={e=>e.key==='Enter'&&handleAdd()} placeholder="Paste a URL to add an idea..." disabled={loading||!dbReady} />
        <button onClick={handleAdd} disabled={loading||!urlVal.trim()||!dbReady}>{loading?'Reading...':'Add'}</button>
        <button className="btn-add-more" onClick={()=>setShowAddModal(true)} disabled={loading||!dbReady}>+ Note / PDF / Image</button>
        <button className="btn-synth" onClick={()=>synthesize()} disabled={synthesizing||cards.length===0}>{synthesizing?'Thinking...':'Synthesize'}</button>
        {selectedCardIds.length > 0 && (
          <button className="btn-synth-selected" onClick={()=>synthesize(cards.filter(c=>selectedCardIds.includes(c.id)))} disabled={synthesizing}>
            Synthesize {selectedCardIds.length} selected
          </button>
        )}
        <button className="btn-queue" onClick={()=>setShowQueue(s=>!s)}>
          Queue{events.length>0?` (${events.length})`:''}
        </button>
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
              <LiminalCard key={card.id} card={card} isDragging={dragging===card.id} onDragStart={startDrag} onDetail={()=>setOpenCard(card)} isSelected={selectedCardIds.includes(card.id)} onToggleSelect={toggleCardSelection} />
            ))}
          </div>

          {openCard&&<DetailPanel card={openCard} cards={cards} onClose={()=>setOpenCard(null)} onUpdate={updateCard} onDelete={deleteCard} />}
        </div>

        {showSynth&&<ThinkingPanel synthesis={synthesis} synthesizing={synthesizing} cards={cards} onClose={()=>setShowSynth(false)} onResynthesize={synthesize} onSpawnCard={spawnCardFromText} onSaveToResearch={()=>setShowCapture(true)} />}
        {showQueue&&<ResearchQueuePanel events={events} cards={cards} onClose={()=>setShowQueue(false)} onOpenEvent={setOpenEvent} />}
      </div>

      {showAddModal&&<AddModal onClose={()=>setShowAddModal(false)} onPending={setPending} setError={setError} setStatus={setStatus} />}

      {showCapture&&(
        <SynthesisCapturePanel
          synthesis={synthesis}
          sourceCardIds={selectedCardIds.length > 0 ? selectedCardIds : cards.map(c=>c.id)}
          cards={cards}
          onSave={saveEvent}
          onClose={()=>setShowCapture(false)}
        />
      )}

      {openEvent&&(
        <EventDetailOverlay
          event={openEvent}
          cards={cards}
          onClose={()=>setOpenEvent(null)}
          onUpdate={updateEvent}
          onDelete={deleteEventItem}
        />
      )}
    </div>
  )
}
