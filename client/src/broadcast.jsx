import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Inbox, MailOpen, Plus, Search, Send, ShieldCheck, UserMinus, UserPlus, Users, X, RefreshCw } from 'lucide-react';

/* ------------------------------------------------------------------ small shared helpers */
const initials = n => String(n || '?').split(/\s|_/).filter(Boolean).slice(0, 2).map(p => p[0]).join('').toUpperCase();
const Av = ({ name, color = '#176b55', size = 'md' }) => <div className={`avatar ${size}`} style={{ '--avatar': color }}>{initials(name)}</div>;
const timeLabel = d => {
  if (!d) return '';
  const date = new Date(d), mins = Math.floor((Date.now() - date) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const fullTime = d => (d ? new Date(d).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const newKey = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
const scopeLabel = scope => ({ university: 'University', campus: 'Campus', department: 'Department', class: 'Class', functional: 'Team', personal: 'Informal' }[scope] || 'Group');

/* ------------------------------------------------------------------ inbox state (REST is the source of truth) */
/**
 * Personal inbox of delivered broadcasts. MongoDB (via /broadcasts/inbox) is authoritative; Socket.IO events are a
 * live convenience. Events are de-duplicated by delivery id, and every (re)connect re-synchronizes from the API.
 */
export function useBroadcastInbox({ token, socket, request, notify }) {
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [filters, setFilters] = useState({ q: '', unread: false });
  const [selectedId, setSelectedId] = useState(null);
  const [sent, setSent] = useState([]);
  const [sentStatus, setSentStatus] = useState('idle');
  const seen = useRef(new Set());
  const filtersRef = useRef(filters); filtersRef.current = filters;
  const requestId = useRef(0);

  const query = useCallback((f, cursor) => {
    const p = new URLSearchParams({ limit: '20' });
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.unread) p.set('unread', '1');
    if (cursor) p.set('cursor', cursor);
    return `/broadcasts/inbox?${p}`;
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    const mine = ++requestId.current;
    try {
      const res = await request(query(filtersRef.current), token);
      if (mine !== requestId.current) return; // a newer request superseded this one
      res.items.forEach(i => seen.current.add(i.delivery._id));
      setItems(res.items); setNextCursor(res.nextCursor); setUnreadCount(res.unreadCount); setStatus('ready'); setError('');
    } catch (e) { if (mine === requestId.current) { setStatus('error'); setError(e.message); } }
  }, [token, request, query]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await request(query(filtersRef.current, nextCursor), token);
      res.items.forEach(i => seen.current.add(i.delivery._id));
      setItems(old => [...old, ...res.items.filter(n => !old.some(o => o.delivery._id === n.delivery._id))]);
      setNextCursor(res.nextCursor);
    } catch (e) { notify(e.message, 'error'); } finally { setLoadingMore(false); }
  }, [nextCursor, loadingMore, request, query, token, notify]);

  const loadSent = useCallback(async () => {
    if (!token) return;
    setSentStatus('loading');
    try { setSent((await request('/broadcasts/sent?limit=30', token)).items); setSentStatus('ready'); } catch { setSentStatus('error'); }
  }, [token, request]);

  // Initial load, and a debounced reload whenever search / unread filter change.
  useEffect(() => { if (!token) return undefined; const t = setTimeout(load, filters.q ? 250 : 0); return () => clearTimeout(t); }, [token, filters, load]);
  useEffect(() => { if (!token) { setItems([]); setUnreadCount(0); setSelectedId(null); setStatus('loading'); seen.current = new Set(); } }, [token]);

  const markRead = useCallback(async id => {
    let wasUnread = false;
    setItems(old => old.map(i => { if (i.broadcast._id === id && !i.delivery.readAt) { wasUnread = true; return { ...i, delivery: { ...i.delivery, readAt: new Date().toISOString() } }; } return i; }));
    if (wasUnread) setUnreadCount(c => Math.max(0, c - 1));
    try { const r = await request(`/broadcasts/${id}/read`, token, { method: 'POST' }); setUnreadCount(r.unreadCount); } catch { load(); }
  }, [request, token, load]);

  const markAllRead = useCallback(async () => {
    try { await request('/broadcasts/read-all', token, { method: 'POST' }); setItems(old => old.map(i => ({ ...i, delivery: { ...i.delivery, readAt: i.delivery.readAt || new Date().toISOString() } }))); setUnreadCount(0); }
    catch (e) { notify(e.message, 'error'); }
  }, [request, token, notify]);

  // Opening a group conversation marks everything delivered to me through that group as read.
  const markGroupRead = useCallback(async groupId => {
    try {
      const r = await request(`/broadcasts/thread/${groupId}/read`, token, { method: 'POST' });
      setItems(old => old.map(i => (!i.delivery.readAt && i.broadcast.groups.some(g => g._id === groupId)) ? { ...i, delivery: { ...i.delivery, readAt: new Date().toISOString() } } : i));
      setUnreadCount(r.unreadCount);
    } catch { /* the next inbox sync corrects the counts */ }
  }, [request, token]);

  const open = useCallback(id => { setSelectedId(id); const item = items.find(i => i.broadcast._id === id); if (item && !item.delivery.readAt) markRead(id); }, [items, markRead]);

  // Open a message that may not be in the loaded page (e.g. from a notification).
  const openById = useCallback(async id => {
    setSelectedId(id);
    if (items.some(i => i.broadcast._id === id)) { const it = items.find(i => i.broadcast._id === id); if (!it.delivery.readAt) markRead(id); return; }
    try {
      const d = await request(`/broadcasts/${id}`, token);
      if (d.role === 'recipient') { setItems(old => (old.some(o => o.delivery._id === d.delivery._id) ? old : [{ delivery: d.delivery, broadcast: d.broadcast }, ...old])); if (!d.delivery.readAt) markRead(id); }
    } catch (e) { notify(e.message, 'error'); setSelectedId(null); }
  }, [items, markRead, request, token, notify]);

  // Live events.
  useEffect(() => {
    if (!socket) return undefined;
    const onNew = p => {
      const id = p?.delivery?._id; if (!id) return;
      if (!seen.current.has(id)) { seen.current.add(id); setUnreadCount(c => c + 1); }
      const f = filtersRef.current;
      const matches = (!f.unread || !p.delivery.readAt) && (!f.q.trim() || p.broadcast.body.toLowerCase().includes(f.q.trim().toLowerCase()));
      if (matches) setItems(old => (old.some(o => o.delivery._id === id) ? old : [p, ...old]));
    };
    const onRead = p => {
      if (typeof p?.unreadCount === 'number') setUnreadCount(p.unreadCount);
      const ids = new Set([...(p?.broadcastIds || []), ...(p?.broadcastId ? [p.broadcastId] : [])]);
      setItems(old => old.map(i => (p?.all || ids.has(i.broadcast._id)) && !i.delivery.readAt ? { ...i, delivery: { ...i.delivery, readAt: new Date().toISOString() } } : i));
    };
    const onReceipt = p => setSent(old => old.map(s => (s._id === p.broadcastId ? { ...s, readCount: p.readCount } : s)));
    const onSentEvt = () => setSent(old => (old.length ? (loadSent(), old) : old));
    const onConnect = () => { load(); };   // re-synchronize inbox + unread count after (re)connecting
    socket.on('broadcast:new', onNew); socket.on('broadcast:read', onRead); socket.on('broadcast:receipt', onReceipt); socket.on('broadcast:sent', onSentEvt); socket.on('connect', onConnect);
    return () => { socket.off('broadcast:new', onNew); socket.off('broadcast:read', onRead); socket.off('broadcast:receipt', onReceipt); socket.off('broadcast:sent', onSentEvt); socket.off('connect', onConnect); };
  }, [socket, load, loadSent]);

  return { markGroupRead, markRead, items, unreadCount, nextCursor, status, error, loadingMore, filters, setFilters, selectedId, setSelectedId, open, openById, markAllRead, load, loadMore, sent, sentStatus, loadSent };
}

/* ------------------------------------------------------------------ inbox screen */
export function InboxView({ inbox, tabs, connected, onCompose, onMessageSender, startMode = 'inbox', initialThread = null, searchRef, me, token, request, notify, socket }) {
  const [mode, setMode] = useState(startMode); // inbox | sent
  const [thread, setThread] = useState(initialThread);  // { groupId, highlightId, choices }
  const { items, unreadCount, status, error, filters, setFilters, selectedId, setSelectedId, open, markAllRead, load, loadMore, nextCursor, loadingMore, sent, sentStatus, loadSent } = inbox;
  useEffect(() => { if (mode === 'sent') loadSent(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clicking a message opens the conversation of its group: ALL earlier messages delivered to me through that group.
  const openReceived = i => { open(i.broadcast._id); setThread({ groupId: i.broadcast.groups[0]?._id, highlightId: i.broadcast._id, choices: i.broadcast.groups }); };
  const openSent = s => { setSelectedId(s._id); setThread({ groupId: s.groups[0]?._id, highlightId: s._id, choices: s.groups }); };
  const close = () => { setThread(null); setSelectedId(null); };
  const selectedKey = selectedId;

  return (
    <div className="messaging-layout inbox-layout">
      <section className="conversation-list">
        <div className="list-head">
          <div><div className="eyebrow">YOUR MESSAGES</div><h2>Inbox <span>{unreadCount}</span></h2></div>
          <button className="new-message-btn" onClick={() => onCompose()}><Plus size={16} /><span>Compose</span></button>
        </div>
        {tabs}
        <div className="inbox-subtabs" role="tablist">
          <button role="tab" aria-selected={mode === 'inbox' && !filters.unread} className={mode === 'inbox' && !filters.unread ? 'active' : ''} onClick={() => { setMode('inbox'); setFilters(f => ({ ...f, unread: false })); }}>All</button>
          <button role="tab" aria-selected={mode === 'inbox' && filters.unread} className={mode === 'inbox' && filters.unread ? 'active' : ''} onClick={() => { setMode('inbox'); setFilters(f => ({ ...f, unread: true })); }}>Unread{unreadCount ? ` (${unreadCount})` : ''}</button>
          <button role="tab" aria-selected={mode === 'sent'} className={mode === 'sent' ? 'active' : ''} onClick={() => setMode('sent')}>Sent</button>
        </div>
        {mode === 'inbox' && <div className="search-box"><Search size={16} /><input ref={searchRef} aria-label="Search messages" placeholder="Search your messages…" value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))} /></div>}
        {!connected && <div className="request-note reconnect-note" role="status"><RefreshCw size={13} /> Reconnecting… new messages will sync automatically.</div>}
        <div className="conversation-scroll">
          {mode === 'inbox' ? (
            status === 'loading' ? <div className="skeleton-list" aria-busy="true">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton-row" />)}</div>
              : status === 'error' ? <div className="empty-list"><AlertCircle size={22} /><b>Couldn’t load your messages</b><span>{error}</span><button onClick={load}>Try again</button></div>
                : items.length === 0 ? <div className="empty-list"><Inbox size={22} /><b>{filters.q ? 'No matching messages' : filters.unread ? 'No unread messages' : 'Your inbox is empty'}</b><span>{filters.q || filters.unread ? 'Try a different search or filter.' : 'Messages sent to your groups will appear here.'}</span></div>
                  : <>
                    {unreadCount > 0 && !filters.q && <button className="mark-all" onClick={markAllRead}><MailOpen size={14} /> Mark all as read</button>}
                    {items.map(i => {
                      const unread = !i.delivery.readAt;
                      return (
                        <button key={i.delivery._id} className={`conversation-item broadcast-item ${selectedKey === i.broadcast._id ? 'selected' : ''} ${unread ? 'unread' : ''}`} onClick={() => openReceived(i)}>
                          <Av name={i.broadcast.sender.name} color={i.broadcast.sender.avatarColor} />
                          <div className="conv-main">
                            <div className="conv-top"><b>{i.broadcast.sender.name}</b><time>{timeLabel(i.broadcast.createdAt)}</time></div>
                            <div className="conv-role">{i.broadcast.sender.role} · {i.broadcast.groups.map(g => g.name).join(', ')}</div>
                            <div className="conv-preview">{unread && <i className="unread-dot" aria-label="Unread" />}{i.broadcast.body}</div>
                          </div>
                        </button>
                      );
                    })}
                    {nextCursor && <button className="load-more" onClick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Load older messages'}</button>}
                  </>
          ) : (
            sentStatus === 'loading' ? <div className="skeleton-list" aria-busy="true">{[0, 1, 2].map(i => <div key={i} className="skeleton-row" />)}</div>
              : sentStatus === 'error' ? <div className="empty-list"><AlertCircle size={22} /><b>Couldn’t load sent messages</b><button onClick={loadSent}>Try again</button></div>
                : sent.length === 0 ? <div className="empty-list"><Send size={22} /><b>Nothing sent yet</b><span>Messages you send to groups appear here.</span></div>
                  : sent.map(s => (
                    <button key={s._id} className={`conversation-item broadcast-item ${selectedKey === s._id ? 'selected' : ''}`} onClick={() => openSent(s)}>
                      <div className="avatar md sent-icon"><Send size={16} /></div>
                      <div className="conv-main">
                        <div className="conv-top"><b>To {s.groups.map(g => g.name).join(', ')}</b><time>{timeLabel(s.createdAt)}</time></div>
                        <div className="conv-role">{s.status === 'pending' ? 'Finishing delivery…' : `Delivered to ${s.recipientCount} · Read by ${s.readCount}`}</div>
                        <div className="conv-preview">{s.body}</div>
                      </div>
                    </button>
                  ))
          )}
        </div>
      </section>

      <section className="chat-panel">
        {thread?.groupId ? (
          <GroupThread key={thread.groupId} groupId={thread.groupId} highlightId={thread.highlightId} choices={thread.choices} me={me} token={token} request={request} notify={notify} socket={socket} inbox={inbox}
            onSwitch={groupId => setThread(t => ({ ...t, groupId, highlightId: null }))} onBack={close} onMessageSender={onMessageSender} />
        ) : (
          <div className="empty-state big"><Inbox size={34} /><h3>Select a message</h3><p>Open a message to see the whole conversation of its group: everything previously delivered to you through it.</p><button className="primary-btn" onClick={() => onCompose()}><Plus size={16} /> Compose message</button></div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ group conversation (per-user thread) */
/**
 * Everything delivered to ME through this group, plus what I sent to it, oldest first. This is not a shared room:
 * the server builds it from my own delivery records, so a member who joined later sees no earlier history.
 */
function GroupThread({ groupId, highlightId, choices = [], me, token, request, notify, socket, inbox, onSwitch, onBack, onMessageSender }) {
  const [group, setGroup] = useState(null);
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef(null);
  const scrollPlan = useRef('highlight');   // highlight | bottom | keep
  const keepFrom = useRef(0);
  const attempt = useRef({ sig: '', key: '' });
  const highlightRef = useRef(highlightId);
  const loadedOnce = useRef(false);   // later re-syncs must not reset the 'load earlier' cursor

  const merge = useCallback(list => setItems(old => {
    const byId = new Map(old.map(i => [i.broadcast._id, i]));
    list.forEach(i => byId.set(i.broadcast._id, { ...byId.get(i.broadcast._id), ...i }));
    return [...byId.values()].sort((a, b) => a.broadcast._id.localeCompare(b.broadcast._id));
  }), []);

  const load = useCallback(async () => {
    try {
      const res = await request(`/broadcasts/thread/${groupId}?limit=30`, token);
      setGroup(res.group); if (!loadedOnce.current) setNextCursor(res.nextCursor); loadedOnce.current = true; merge(res.items); setStatus('ready'); setError('');
      if (res.unreadInGroup > 0) inbox.markGroupRead(groupId);
    } catch (e) { setStatus('error'); setError(e.message); }
  }, [groupId, token, request, merge, inbox]);
  useEffect(() => { load(); }, [groupId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadOlder = async () => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true); keepFrom.current = scroller.current?.scrollHeight || 0; scrollPlan.current = 'keep';
    try { const res = await request(`/broadcasts/thread/${groupId}?limit=30&cursor=${nextCursor}`, token); merge(res.items); setNextCursor(res.nextCursor); }
    catch (e) { notify(e.message, 'error'); } finally { setLoadingOlder(false); }
  };

  // Scroll management: jump to the clicked message first time, stick to the bottom for new messages, keep place for older pages.
  useEffect(() => {
    const el = scroller.current; if (!el || status !== 'ready') return;
    if (scrollPlan.current === 'keep') { el.scrollTop = el.scrollHeight - keepFrom.current; scrollPlan.current = 'bottom'; return; }
    if (scrollPlan.current === 'highlight') {
      const target = highlightRef.current ? el.querySelector(`[data-mid="${highlightRef.current}"]`) : null;
      if (target) target.scrollIntoView({ block: 'center' }); else el.scrollTop = el.scrollHeight;
      scrollPlan.current = 'bottom'; return;
    }
    el.scrollTop = el.scrollHeight;
  }, [items, status]);

  // Live updates and reconnect resynchronization.
  useEffect(() => {
    if (!socket) return undefined;
    const onNew = p => {
      if (!p?.broadcast?.groups?.some(g => g._id === groupId)) return;
      scrollPlan.current = 'bottom';
      merge([{ kind: 'received', mine: false, readAt: null, broadcast: { _id: p.broadcast._id, body: p.broadcast.body, createdAt: p.broadcast.createdAt, sender: p.broadcast.sender, alsoTo: p.broadcast.groups.filter(g => g._id !== groupId).map(g => g.name) } }]);
      inbox.markRead(p.broadcast._id);   // the conversation is open, so it is read immediately
    };
    const onSentElsewhere = () => { scrollPlan.current = 'bottom'; load(); };   // I sent from another tab/device
    socket.on('broadcast:new', onNew); socket.on('broadcast:sent', onSentElsewhere); socket.on('connect', load);
    return () => { socket.off('broadcast:new', onNew); socket.off('broadcast:sent', onSentElsewhere); socket.off('connect', load); };
  }, [socket, groupId, load, merge, inbox]);

  async function send(e) {
    e?.preventDefault();
    const text = draft.trim(); if (!text || sending || !group?.canBroadcast) return;
    const sig = JSON.stringify([groupId, text]);
    if (attempt.current.sig !== sig) attempt.current = { sig, key: newKey() };   // same key only for an identical retry
    setSending(true);
    try {
      const r = await request('/broadcasts', token, { method: 'POST', body: JSON.stringify({ groupIds: [groupId], body: text, clientMessageId: attempt.current.key }) });
      attempt.current = { sig: '', key: '' }; setDraft(''); scrollPlan.current = 'bottom';
      merge([{ kind: 'sent', mine: true, readAt: null, broadcast: { _id: r.broadcast._id, body: r.broadcast.body, createdAt: r.broadcast.createdAt, sender: { _id: me._id, name: me.name, role: me.role, avatarColor: me.avatarColor }, alsoTo: [] } }]);
    } catch (err) { notify(err.message, 'error'); } finally { setSending(false); }
  }

  const readOnlyNote = !group ? '' : !group.canBroadcast ? (group.isMember || group.official ? 'Only authorized senders can message this group.' : 'You are no longer a member. You can read earlier messages, but cannot send.') : '';
  let lastDay = '';
  return (
    <>
      <div className="chat-header">
        <button type="button" className="chat-back" aria-label="Back to messages" onClick={onBack}><ArrowLeft size={20} /></button>
        <div className="chat-person">
          <div className="avatar md sent-icon"><Users size={18} /></div>
          <div><b>{group?.name || 'Group'}</b><span>{group ? `${group.official ? 'Official group' : 'Informal group'}${group.memberCount ? ` · ${group.memberCount} members` : ''}${group.isMember ? '' : ' · you are not a member'}` : 'Loading…'}</span></div>
        </div>
      </div>
      {choices.length > 1 && <div className="thread-choices" aria-label="Groups this message was sent to"><span>This message also reached:</span>{choices.map(c => <button key={c._id} className={`chip ${c._id === groupId ? 'on' : ''}`} onClick={() => onSwitch(c._id)}>{c.name}</button>)}</div>}
      <div className="thread-scroll" ref={scroller} aria-live="polite">
        {status === 'loading' && <div className="skeleton-list" aria-busy="true">{[0, 1, 2].map(i => <div key={i} className="skeleton-row" />)}</div>}
        {status === 'error' && <div className="empty-list"><AlertCircle size={22} /><b>Couldn’t load this conversation</b><span>{error}</span><button onClick={load}>Try again</button></div>}
        {status === 'ready' && <>
          {nextCursor && <button className="load-more" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}
          {!nextCursor && items.length > 0 && <div className="thread-start">Start of the conversation you can see</div>}
          {items.length === 0 && <div className="empty-list"><Inbox size={22} /><b>No messages yet</b><span>Nothing has been delivered to you through this group.</span></div>}
          {items.map(i => {
            const day = dayLabelOf(i.broadcast.createdAt), showDay = day !== lastDay; lastDay = day;
            return (
              <React.Fragment key={i.broadcast._id}>
                {showDay && <div className="date-divider"><span>{day}</span></div>}
                <div data-mid={i.broadcast._id} className={`thread-msg ${i.mine ? 'mine' : ''} ${i.broadcast._id === highlightId ? 'highlight' : ''}`}>
                  {!i.mine && <Av name={i.broadcast.sender.name} color={i.broadcast.sender.avatarColor} size="sm" />}
                  <div className="thread-bubble">
                    {!i.mine && <div className="thread-sender"><b>{i.broadcast.sender.name}</b><span>{i.broadcast.sender.role}</span></div>}
                    <div className="thread-text">{i.broadcast.body}</div>
                    <div className="thread-meta">
                      {i.broadcast.alsoTo?.length > 0 && <span>also to {i.broadcast.alsoTo.join(', ')}</span>}
                      {!i.mine && <button type="button" className="link-btn quiet" onClick={() => onMessageSender(i.broadcast.sender)}>Reply privately</button>}
                      <time>{new Date(i.broadcast.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                      {i.mine && <Check size={12} aria-label="Sent" />}
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </>}
      </div>
      {group && (group.canBroadcast
        ? <form className="thread-composer" onSubmit={send}>
          <input aria-label={`Message ${group.name}`} placeholder={`Message ${group.name}…`} maxLength={5000} value={draft} onChange={e => setDraft(e.target.value)} />
          <button className="send-btn" aria-label="Send message" disabled={!draft.trim() || sending}><Send size={18} /></button>
        </form>
        : <div className="thread-readonly"><ShieldCheck size={14} /> {readOnlyNote}</div>)}
    </>
  );
}
const dayLabelOf = d => { const dt = new Date(d), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1); const same = (a, c) => a.toDateString() === c.toDateString(); return same(dt, t) ? 'Today' : same(dt, y) ? 'Yesterday' : dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };

/* ------------------------------------------------------------------ compose screen */
export function ComposeView({ token, request, notify, preselect = [], onDone, refreshKey = 0 }) {
  const [query, setQuery] = useState('');
  const [audiences, setAudiences] = useState([]);
  const [audStatus, setAudStatus] = useState('loading');
  const [selected, setSelected] = useState([]);
  const [body, setBody] = useState('');
  const [count, setCount] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const attempt = useRef({ sig: '', key: '' });
  const preselected = useRef(false);

  useEffect(() => {
    let live = true; setAudStatus('loading');
    const t = setTimeout(async () => {
      try { const rows = await request(`/broadcasts/audiences?q=${encodeURIComponent(query)}`, token); if (!live) return; setAudiences(rows); setAudStatus('ready');
        if (!query) setSelected(old => old.filter(o => rows.some(r => r._id === o._id)));   /* a revoked audience cannot stay selected */ if (!preselected.current && preselect.length) { preselected.current = true; setSelected(rows.filter(r => preselect.includes(r._id))); } }
      catch { if (live) setAudStatus('error'); }
    }, query ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [query, token, request, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server calculates (and re-checks) the audience size; the client never computes recipients.
  useEffect(() => {
    setCount(null); setPreviewError('');
    if (!selected.length) return undefined;
    let live = true;
    request('/broadcasts/preview', token, { method: 'POST', body: JSON.stringify({ groupIds: selected.map(s => s._id) }) })
      .then(r => live && setCount(r.recipientCount)).catch(e => live && setPreviewError(e.message));
    return () => { live = false; };
  }, [selected, token, request]);

  const toggle = g => setSelected(old => (old.some(o => o._id === g._id) ? old.filter(o => o._id !== g._id) : old.length >= 10 ? (notify('You can choose up to 10 groups.', 'error'), old) : [...old, g]));
  const canSend = selected.length > 0 && body.trim().length > 0 && body.length <= 5000 && !sending && !previewError;

  async function send(e) {
    e?.preventDefault();
    if (!canSend) return;
    const ids = selected.map(s => s._id).sort(), sig = JSON.stringify([ids, body.trim()]);
    // The same idempotency key is reused ONLY for an identical retry, so a network retry can never duplicate the message.
    if (attempt.current.sig !== sig) attempt.current = { sig, key: newKey() };
    setSending(true);
    try {
      const r = await request('/broadcasts', token, { method: 'POST', body: JSON.stringify({ groupIds: ids, body: body.trim(), clientMessageId: attempt.current.key }) });
      attempt.current = { sig: '', key: '' };
      setResult({ recipientCount: r.recipientCount, groups: selected.map(s => s.name) });
      setBody(''); setSelected([]); notify(`Message delivered to ${r.recipientCount} ${r.recipientCount === 1 ? 'person' : 'people'}.`);
    } catch (err) { notify(err.message, 'error'); } finally { setSending(false); }
  }

  const official = audiences.filter(a => a.official), informal = audiences.filter(a => !a.official);
  const Option = ({ g }) => {
    const on = selected.some(s => s._id === g._id);
    return <button type="button" role="checkbox" aria-checked={on} className={`audience-option ${on ? 'on' : ''}`} onClick={() => toggle(g)}>
      <span className="check-box">{on && <Check size={13} />}</span>
      <span className="audience-text"><b>{g.name}</b><small>{scopeLabel(g.scope)}{g.campus ? ` · ${g.campus}` : ''}{g.department ? ` · ${g.department}` : ''} · {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}</small></span>
    </button>;
  };

  return (
    <section className="page-section compose-page">
      <div className="page-title-row"><div><div className="eyebrow">NEW MESSAGE</div><h1>Compose message</h1><p>Choose who should receive it. Each person gets it in their own inbox.</p></div></div>
      {result && <div className="success-banner" role="status"><Check size={18} /><div><b>Delivered to {result.recipientCount} {result.recipientCount === 1 ? 'person' : 'people'}</b><span>{result.groups.join(', ')}</span></div><button className="ghost-btn" onClick={() => onDone?.()}>View sent messages</button><button className="icon-btn" aria-label="Dismiss" onClick={() => setResult(null)}><X size={16} /></button></div>}
      <div className="compose-grid">
        <div className="compose-card">
          <h3>1 · Audience</h3>
          <div className="search-box"><Search size={16} /><input aria-label="Search groups" placeholder="Search groups you can message…" value={query} onChange={e => setQuery(e.target.value)} /></div>
          {selected.length > 0 && <div className="chip-row" aria-label="Selected audience">{selected.map(s => <span className="chip selected-chip" key={s._id}>{s.name}<button type="button" aria-label={`Remove ${s.name}`} onClick={() => toggle(s)}><X size={12} /></button></span>)}</div>}
          <div className="audience-list" aria-busy={audStatus === 'loading'}>
            {audStatus === 'loading' && !audiences.length ? <div className="skeleton-list">{[0, 1, 2].map(i => <div key={i} className="skeleton-row" />)}</div>
              : audStatus === 'error' ? <div className="empty-list"><AlertCircle size={20} /><b>Couldn’t load groups</b><button onClick={() => setQuery(q => q + ' ')}>Try again</button></div>
                : audiences.length === 0 ? <div className="empty-list"><Users size={20} /><b>{query ? 'No matching groups' : 'No groups available to message'}</b><span>{query ? 'Try a different name.' : 'You can message groups you own or have been given permission for. Create an informal group from the Groups page.'}</span></div>
                  : <>
                    {official.length > 0 && <div className="audience-section">Official groups</div>}{official.map(g => <Option key={g._id} g={g} />)}
                    {informal.length > 0 && <div className="audience-section">Informal groups</div>}{informal.map(g => <Option key={g._id} g={g} />)}
                  </>}
          </div>
        </div>
        <form className="compose-card" onSubmit={send}>
          <h3>2 · Message</h3>
          <textarea aria-label="Message" rows="9" maxLength={5000} placeholder="Write your message…" value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e); }} />
          <div className="compose-meta"><span className={body.length > 4800 ? 'warn' : ''}>{body.length}/5000</span>
            <span className="recipient-count" aria-live="polite">{!selected.length ? 'Select at least one group' : previewError ? previewError : count === null ? 'Calculating recipients…' : <>Will reach <b>{count}</b> {count === 1 ? 'person' : 'people'}</>}</span></div>
          <div className="modal-note"><ShieldCheck size={16} /> People in several selected groups receive one copy. The server confirms who is eligible when you send.</div>
          <button className="primary-btn modal-submit" disabled={!canSend}><Send size={16} /> {sending ? 'Sending…' : `Send${count ? ` to ${count}` : ''}`}</button>
        </form>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ groups (audiences, not chat rooms) */
const visibilityLabel = { private: 'Invite only', approval: 'Join by approval', open: 'Open to join' };
const postingLabel = g => {
  const chosen = g.senderCount ? ` + ${g.senderCount} chosen` : '';
  if (g.official) return `Institutional senders${chosen}`;
  return g.postingPolicy === 'members' ? 'Any member can message' : g.postingPolicy === 'publishers' ? `Owner${chosen || ' + chosen senders'}` : 'Owner only';
};

export function GroupsView({ groups, invitations, me, token, request, notify, reload, reloadInvitations, onCompose, onCreate, onOpenConversation }) {
  const [filter, setFilter] = useState('mine');
  const [q, setQ] = useState('');
  const [managing, setManaging] = useState(null);
  const [busy, setBusy] = useState('');
  const shown = useMemo(() => groups.filter(g => {
    if (q && !g.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'mine') return g.isMember || g.isOwner;
    if (filter === 'official') return g.official;
    if (filter === 'informal') return !g.official;
    if (filter === 'discover') return !g.isMember && !g.isOwner;
    return true;
  }), [groups, filter, q]);

  const act = async (key, fn) => { setBusy(key); try { await fn(); } catch (e) { notify(e.message, 'error'); } finally { setBusy(''); } };
  const join = g => act(`j${g._id}`, async () => { const r = await request(`/groups/${g._id}/join`, token, { method: 'POST' }); notify(r.message || 'Done'); await reload(); });
  const leave = g => act(`l${g._id}`, async () => { if (!window.confirm(`Leave ${g.name}? You will stop receiving its messages.`)) return; const r = await request(`/groups/${g._id}/leave`, token, { method: 'POST' }); notify(r.message); await reload(); });
  const respond = (inv, decision) => act(`i${inv.groupId}`, async () => { const r = await request(`/groups/${inv.groupId}/invitations/respond`, token, { method: 'POST', body: JSON.stringify({ decision }) }); notify(r.message); await Promise.all([reload(), reloadInvitations()]); });

  return (
    <section className="page-section">
      <div className="page-title-row">
        <div><div className="eyebrow">AUDIENCES</div><h1>Groups</h1><p>Groups are audiences. A message sent to a group lands in each member’s own inbox.</p></div>
        <button className="primary-btn" onClick={onCreate}><Plus size={17} /> Create group</button>
      </div>
      {invitations.length > 0 && <div className="invite-banner" role="region" aria-label="Group invitations">
        <b><UserPlus size={16} /> You have {invitations.length} group {invitations.length === 1 ? 'invitation' : 'invitations'}</b>
        {invitations.map(inv => <div className="invite-row" key={inv.groupId}><div><b>{inv.name}</b><span>Invited by {inv.owner?.name || 'the owner'}</span></div>
          <button className="ghost-btn" disabled={busy === `i${inv.groupId}`} onClick={() => respond(inv, 'decline')}>Decline</button>
          <button className="primary-btn" disabled={busy === `i${inv.groupId}`} onClick={() => respond(inv, 'accept')}>Accept</button></div>)}
      </div>}
      <div className="group-toolbar">
        <div className="inbox-subtabs" role="tablist">{[['mine', 'My groups'], ['official', 'Official'], ['informal', 'Informal'], ['discover', 'Discover'], ['all', 'All']].map(([k, label]) => <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>{label}</button>)}</div>
        <div className="search-box"><Search size={16} /><input aria-label="Search groups" placeholder="Search groups…" value={q} onChange={e => setQ(e.target.value)} /></div>
      </div>
      <div className="group-grid">
        {shown.map(g => (
          <div className="group-card audience-card" key={g._id}>
            <div className="group-card-body">
              <div className="group-type"><span className={`badge ${g.official ? 'official' : 'informal'}`}>{g.official ? 'Official' : 'Informal'}</span>{g.official && <> {scopeLabel(g.scope)}{g.campus && g.scope !== 'university' ? ` · ${g.campus}` : ''}</>}</div>
              <h3>{g.name}</h3>
              <p>{g.description || 'No description.'}</p>
              <ul className="group-facts">
                <li><Users size={13} /> {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}</li>
                {!g.official && <li><ShieldCheck size={13} /> {visibilityLabel[g.visibility]}</li>}
                <li><Send size={13} /> {postingLabel(g)}</li>
              </ul>
              <div className="group-actions">
                {(g.isMember || g.isOwner) && <button className="ghost-btn" onClick={() => onOpenConversation(g)}><MailOpen size={14} /> Conversation</button>}
                {g.canBroadcast && <button className="primary-btn" onClick={() => onCompose([g._id])}><Send size={14} /> Message group</button>}
                {(g.canManageMembers || g.isOwner) && <button className="ghost-btn" onClick={() => setManaging(g)}>Manage</button>}
                {!g.isMember && !g.isOwner && g.visibility !== 'private' && (g.joinRequestPending ? <span className="muted-note">Request pending</span> : <button className="ghost-btn" disabled={busy === `j${g._id}`} onClick={() => join(g)}>{g.visibility === 'approval' ? 'Request to join' : 'Join'}</button>)}
                {g.isMember && !g.isOwner && !g.official && <button className="link-btn" disabled={busy === `l${g._id}`} onClick={() => leave(g)}>Leave</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      {shown.length === 0 && <div className="empty-state"><Users /><h3>{q ? 'No matching groups' : filter === 'discover' ? 'Nothing to discover right now' : 'No groups here yet'}</h3><p>{filter === 'mine' ? 'Create an informal group for a project, study circle or team.' : 'Try another filter.'}</p></div>}
      {managing && <GroupManageModal group={managing} me={me} token={token} request={request} notify={notify} onClose={() => setManaging(null)} onChanged={reload} />}
    </section>
  );
}

function GroupManageModal({ group, me, token, request, notify, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [people, setPeople] = useState([]);
  const [settings, setSettings] = useState({ visibility: group.visibility, postingPolicy: ['members', 'publishers'].includes(group.postingPolicy) ? group.postingPolicy : 'owner' });
  const [busy, setBusy] = useState('');
  const [sendersVersion, setSendersVersion] = useState(0);
  const informal = !group.official;

  const refresh = useCallback(async () => {
    try { const rows = await request('/management/groups', token); const found = rows.find(r => r._id === group._id); if (!found) throw new Error('You no longer manage this group.'); setDetail(found); setError(''); }
    catch (e) { if (!group.isOwner) setError(e.message); }   // an owner without member-management rights still controls senders
  }, [request, token, group._id]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (!q.trim()) { setPeople([]); return undefined; } const t = setTimeout(async () => { try { setPeople(await request(`/users?q=${encodeURIComponent(q)}`, token)); } catch { setPeople([]); } }, 250); return () => clearTimeout(t); }, [q, request, token]);

  const run = async (key, fn, okMsg) => { setBusy(key); try { const r = await fn(); notify(okMsg || r?.message || 'Saved'); await refresh(); await onChanged(); } catch (e) { notify(e.message, 'error'); } finally { setBusy(''); } };
  const member = (userId, action) => run(`${action}${userId}`, () => request(`/management/groups/${group._id}/members`, token, { method: 'PATCH', body: JSON.stringify({ userId, action }) }));
  const decide = (reqId, decision) => run(`d${reqId}`, () => request(`/groups/${group._id}/join-requests/${reqId}`, token, { method: 'PATCH', body: JSON.stringify({ decision }) }));
  const save = async () => { await run('settings', () => request(`/groups/${group._id}/settings`, token, { method: 'PATCH', body: JSON.stringify(settings) }), 'Group settings saved.'); setSendersVersion(v => v + 1); };

  const members = detail?.members || [];
  const pendingJoin = (detail?.joinRequests || []).filter(r => r.status === 'pending');
  const pendingInvites = (detail?.invitations || []).filter(i => i.status === 'pending');
  const memberIds = new Set(members.map(m => m._id));

  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide-modal" role="dialog" aria-modal="true" aria-label={`Manage ${group.name}`}>
        <div className="modal-header"><div><div className="eyebrow">{informal ? 'INFORMAL GROUP' : 'OFFICIAL GROUP'}</div><h2>{group.name}</h2></div><button className="icon-btn" aria-label="Close" onClick={onClose}><X /></button></div>
        {error ? <div className="empty-list"><AlertCircle size={20} /><b>{error}</b></div> : !detail && !group.isOwner ? <div className="skeleton-list"><div className="skeleton-row" /><div className="skeleton-row" /></div> : (
          <div className="manage-body">
            {informal && group.isOwner && <div className="manage-section">
              <h4>Settings</h4>
              <div className="form-row">
                <label>Who can find and join<select value={settings.visibility} onChange={e => setSettings(s => ({ ...s, visibility: e.target.value }))}><option value="private">Invite only</option><option value="approval">Discoverable, join by approval</option><option value="open">Open to eligible users</option></select></label>
                <label>Who can message the group<select value={settings.postingPolicy} onChange={e => setSettings(s => ({ ...s, postingPolicy: e.target.value }))}><option value="owner">Only me (owner)</option><option value="publishers">Me and people I choose</option><option value="members">Any member</option></select></label>
              </div>
              <button className="primary-btn" disabled={busy === 'settings'} onClick={save}>Save settings</button>
            </div>}
            {group.isOwner && <SendersSection key={sendersVersion} group={group} token={token} request={request} notify={notify} policy={settings.postingPolicy} onPolicy={p => setSettings(s => ({ ...s, postingPolicy: p }))} onChanged={onChanged} />}
            {!informal && <div className="modal-note"><ShieldCheck size={16} /> Which roles may message this group is set on the Group permissions screen by an authorized administrator. As owner you can additionally choose individual members above.</div>}
            {detail && <>
            {pendingJoin.length > 0 && <div className="manage-section"><h4>Join requests</h4>{pendingJoin.map(r => <div className="member-row" key={r._id}><div><b>{r.user?.name || 'User'}</b><span>{r.user?.role}</span></div><button className="ghost-btn" disabled={busy === `d${r._id}`} onClick={() => decide(r._id, 'decline')}>Decline</button><button className="primary-btn" disabled={busy === `d${r._id}`} onClick={() => decide(r._id, 'approve')}>Approve</button></div>)}</div>}
            <div className="manage-section">
              <h4>{informal ? 'Invite people' : 'Add members'}</h4>
              <div className="search-box"><Search size={16} /><input aria-label="Search people to add" placeholder="Search by name or email…" value={q} onChange={e => setQ(e.target.value)} /></div>
              {informal && <p className="muted-note">People you invite must accept before they join and receive messages.</p>}
              {people.filter(p => !memberIds.has(p._id)).slice(0, 6).map(p => <div className="member-row" key={p._id}><div><b>{p.name}</b><span>{p.role} · {p.department || p.campus || 'COMSATS'}</span></div><button className="ghost-btn" disabled={busy === `add${p._id}`} onClick={() => member(p._id, 'add')}><UserPlus size={14} /> {informal ? 'Invite' : 'Add'}</button></div>)}
              {pendingInvites.length > 0 && <p className="muted-note">{pendingInvites.length} invitation{pendingInvites.length === 1 ? '' : 's'} awaiting a response.</p>}
            </div>
            <div className="manage-section">
              <h4>Members ({members.length})</h4>
              <div className="member-list">{members.map(m => <div className="member-row" key={m._id}><Av name={m.name} size="sm" /><div><b>{m.name}{m._id === me._id ? ' (you)' : ''}</b><span>{m.role}{String(detail.owner?._id) === m._id ? ' · Owner' : ''}</span></div>{String(detail.owner?._id) !== m._id && <button className="icon-btn" aria-label={`Remove ${m.name}`} title="Remove from group" disabled={busy === `remove${m._id}`} onClick={() => { if (window.confirm(`Remove ${m.name} from ${group.name}? They will stop receiving its messages.`)) member(m._id, 'remove'); }}><UserMinus size={16} /></button>}</div>)}</div>
            </div>
            </>}
          </div>
        )}
      </div>
    </div>
  );
}

/* Owner-controlled list of members who may send messages to this group (informal AND official groups). */
function SendersSection({ group, token, request, notify, onPolicy, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => { try { setData(await request(`/groups/${group._id}/senders`, token)); setErr(''); } catch (e) { setErr(e.message); } }, [request, token, group._id]);
  useEffect(() => { load(); }, [load]);
  const toggle = async m => {
    setBusy(m._id);
    try {
      const r = await request(`/groups/${group._id}/senders`, token, { method: 'PATCH', body: JSON.stringify({ userId: m._id, canSend: !m.canSend }) });
      if (r.postingPolicy) onPolicy(r.postingPolicy);
      notify(r.message); await load(); await onChanged();
    } catch (e) { notify(e.message, 'error'); } finally { setBusy(''); }
  };
  const everyone = data && !data.official && data.postingPolicy === 'members';
  return (
    <div className="manage-section">
      <h4>Who can send messages</h4>
      {err ? <div className="muted-note" role="alert">{err}</div> : !data ? <div className="skeleton-row" /> : <>
        <p className="muted-note">
          {data.official
            ? <>Institutional roles allowed to send: <b>{data.postingRoles.join(', ') || 'none'}</b> (set by administrators). You can additionally let individual members send, but you cannot override institutional rules.</>
            : everyone ? 'Every member can send. Choose “Me and people I choose” above to pick individuals.'
              : data.postingPolicy === 'publishers' ? 'You and the members you choose below can send.' : 'Only you can send. Turn on a member below to let them send too.'}
        </p>
        {!everyone && (data.members.length === 0 ? <p className="muted-note">No other members yet.</p> : <div className="member-list">
          {data.members.map(m => (
            <div className="member-row" key={m._id}>
              <Av name={m.name} size="sm" /><div><b>{m.name}</b><span>{m.role}{!m.eligible ? ' · not eligible' : ''}</span></div>
              <button type="button" role="switch" aria-checked={m.canSend} aria-label={`${m.name} can send messages`} className={`switch ${m.canSend ? 'on' : ''}`} disabled={busy === m._id || (!m.canSend && !m.eligible)} title={!m.eligible ? 'Not eligible to send to this group' : m.canSend ? 'Remove permission to send' : 'Allow to send'} onClick={() => toggle(m)}><i /></button>
            </div>
          ))}
        </div>)}
      </>}
    </div>
  );
}

/* ------------------------------------------------------------------ create group (informal for everyone, official for authorized officials) */
const DEPT_SCOPES = ['department', 'class', 'functional'];
const SCOPE_HELP = {
  university: 'Reaches the whole university.',
  campus: 'Reaches one campus.',
  department: 'Reaches one department of a campus.',
  class: 'A class or section within a department.',
  functional: 'A team or committee within a department.'
};
export function CreateGroupForm({ token, request, notify, onCreated }) {
  const [opts, setOpts] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [kind, setKind] = useState('informal');
  const [scope, setScope] = useState('');
  const [campus, setCampus] = useState('');
  const [department, setDepartment] = useState('');
  const [roles, setRoles] = useState([]);
  const [autoEnroll, setAutoEnroll] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    request('/groups/creatable', token).then(o => { if (!live) return; setOpts(o); setRoles(o.eligibleRoles); if (o.official.length) pickScope(o, o.official[0].scope); }).catch(e => live && setLoadError(e.message));
    return () => { live = false; };
  }, [token, request]); // eslint-disable-line react-hooks/exhaustive-deps

  // Choose a scope and pre-fill campus/department with what this person's authority allows.
  function pickScope(o, s) {
    setScope(s); setAutoEnroll(false);
    const sc = o.official.find(x => x.scope === s);
    if (!sc || s === 'university') { setCampus(''); setDepartment(''); return; }
    const c = sc.anyCampus ? o.defaults.campus : sc.campuses[0]?.campus || '';
    setCampus(c);
    const ce = sc.campuses.find(x => x.campus === c);
    setDepartment(DEPT_SCOPES.includes(s) ? (ce && !ce.anyDepartment ? ce.departments[0] || '' : o.defaults.department) : '');
  }

  const sc = opts?.official.find(o => o.scope === scope);
  const campusEntry = sc?.campuses.find(c => c.campus === campus);
  const official = kind === 'official' && !!sc;
  const toggleRole = r => setRoles(old => (old.includes(r) ? old.filter(x => x !== r) : [...old, r]));

  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const body = official
        ? { name: f.get('name'), description: f.get('description'), scope, campus, department, visibility: f.get('visibility'), eligibleRoles: roles, autoEnroll, allowMemberDirectMessages: f.get('allowMemberDirectMessages') === 'on' }
        : { name: f.get('name'), description: f.get('description'), scope: 'personal', visibility: f.get('visibility'), allowMemberDirectMessages: f.get('allowMemberDirectMessages') === 'on' };
      const g = await request('/groups', token, { method: 'POST', body: JSON.stringify(body) });
      if (!official && f.get('postingPolicy') && f.get('postingPolicy') !== 'owner') await request(`/groups/${g._id}/settings`, token, { method: 'PATCH', body: JSON.stringify({ postingPolicy: f.get('postingPolicy') }) });
      onCreated(official ? `Official group created${g.enrolled ? `. ${g.enrolled} ${g.enrolled === 1 ? 'person was' : 'people were'} added automatically` : '. Add members from Manage'}.` : 'Group created. Invite people from Manage.');
    } catch (err) { notify(err.message, 'error'); } finally { setBusy(false); }
  }

  if (loadError) return <div className="empty-list"><AlertCircle size={20} /><b>Couldn’t load group options</b><span>{loadError}</span></div>;
  if (!opts) return <div className="skeleton-list"><div className="skeleton-row" /><div className="skeleton-row" /></div>;

  return (
    <form className="modal-form" onSubmit={submit}>
      {opts.official.length > 0 && <div className="inbox-subtabs kind-tabs" role="tablist" aria-label="Group type">
        <button type="button" role="tab" aria-selected={kind === 'informal'} className={kind === 'informal' ? 'active' : ''} onClick={() => setKind('informal')}>Informal group</button>
        <button type="button" role="tab" aria-selected={kind === 'official'} className={kind === 'official' ? 'active' : ''} onClick={() => setKind('official')}>Official group</button>
      </div>}
      <label>Group name<input name="name" required maxLength={120} placeholder={official ? 'e.g. IslamabadCampus_Faculty' : 'e.g. Final Year Project Team'} /></label>
      <label>Description<textarea name="description" rows="2" placeholder="What is this group for?" /></label>

      {official && <>
        <label>Group level
          <select value={scope} onChange={e => pickScope(opts, e.target.value)}>{opts.official.map(o => <option key={o.scope} value={o.scope}>{scopeLabel(o.scope)}: {SCOPE_HELP[o.scope]}</option>)}</select>
        </label>
        {scope !== 'university' && <div className="form-row">
          <label>Campus
            {sc.anyCampus ? <input value={campus} onChange={e => setCampus(e.target.value)} required placeholder="e.g. Islamabad" />
              : <select value={campus} onChange={e => { setCampus(e.target.value); const ce = sc.campuses.find(c => c.campus === e.target.value); setDepartment(ce && !ce.anyDepartment ? ce.departments[0] || '' : department); }}>{sc.campuses.map(c => <option key={c.campus}>{c.campus}</option>)}</select>}
          </label>
          {DEPT_SCOPES.includes(scope) && <label>Department
            {sc.anyCampus || campusEntry?.anyDepartment ? <input value={department} onChange={e => setDepartment(e.target.value)} required placeholder="e.g. Computer Science" />
              : <select value={department} onChange={e => setDepartment(e.target.value)}>{(campusEntry?.departments || []).map(d => <option key={d}>{d}</option>)}</select>}
          </label>}
        </div>}
        <fieldset className="role-fieldset"><legend>Who can be a member</legend>
          <div className="role-grid">{opts.eligibleRoles.map(r => <label key={r} className="checkbox-label"><input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} /> {r}</label>)}</div>
        </fieldset>
        {['university', 'campus', 'department'].includes(scope) && <label className="checkbox-label"><input type="checkbox" checked={autoEnroll} onChange={e => setAutoEnroll(e.target.checked)} /> Automatically add everyone in this scope who has an allowed role (now and when new accounts join)</label>}
      </>}

      <div className="form-row">
        {!official && <label>Who can message the group<select name="postingPolicy"><option value="owner">Only me (owner)</option><option value="publishers">Me and people I choose</option><option value="members">Any member</option></select></label>}
        <label>Visibility<select name="visibility" defaultValue="private"><option value="private">Private / invite-only</option><option value="approval">Discoverable with approval</option><option value="open">Open to eligible users</option></select></label>
      </div>
      <label className="checkbox-label"><input type="checkbox" name="allowMemberDirectMessages" /> Allow direct messages between members of this group</label>
      <div className="modal-note"><ShieldCheck size={16} /> {official
        ? 'Official groups follow institutional rules. Which roles may send is set on Group permissions; as owner you can also choose individual senders. Technical Admin accounts cannot be members.'
        : 'An informal group is an audience you can message. Invited people join only after accepting, and nobody sees a shared chat room.'}</div>
      <button className="primary-btn modal-submit" disabled={busy || (official && roles.length === 0)}><Plus size={16} /> {busy ? 'Creating…' : official ? 'Create official group' : 'Create group'}</button>
    </form>
  );
}
