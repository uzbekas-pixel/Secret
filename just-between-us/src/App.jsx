import { useCallback, useEffect, useRef, useState } from "react";
import {
  collection, onSnapshot, query, orderBy, addDoc, doc, getDoc, writeBatch,
  updateDoc, deleteDoc, setDoc, serverTimestamp, FieldPath, arrayUnion, arrayRemove,
} from "firebase/firestore";
import { db } from "./firebase";

const ADMIN_PASSCODE = "uzbekas";
const PLACEHOLDER = "[Write your secret here...]";
const MAX_IMAGE_MB = 5;
const MAX_MESSAGE_LEN = 2000;
const APP_TITLE = "Just Between Us";

const ts = (m) => m.createdAt?.toMillis?.() ?? Date.now();

/* ---------- Helpers ---------- */
// localStorage / sessionStorage can throw (private mode, blocked cookies)
const safeStore = {
  get: (area, k) => { try { return area.getItem(k); } catch { return null; } },
  set: (area, k, v) => { try { area.setItem(k, v); } catch { /* ignore */ } },
  remove: (area, k) => { try { area.removeItem(k); } catch { /* ignore */ } },
};

const deleteImageByUrl = async (url) => {
  // ImgBB doesn't support client-side delete for security
  // Images remain on server but won't be referenced
  if (!url) return;
  console.log("Image URL no longer referenced:", url);
};

const dayLabel = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    day: "numeric", month: "long",
    year: d.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
};

const copyText = async (txt) => {
  try { await navigator.clipboard.writeText(txt); }
  catch {
    // Fallback for non-HTTPS / older browsers
    const ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
  }
};

/* ---------- Icons ---------- */
const Icon = ({ d, className = "w-5 h-5", strokeWidth = 2 }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} d={d} />
  </svg>
);

/* ---------- Skeleton ---------- */
const Skeleton = ({ className = "" }) => (
  <div className={`animate-pulse bg-white/5 rounded ${className}`} />
);
const ICONS = {
  check: "M5 13l4 4L19 7",
  x: "M6 18L18 6M6 6l12 12",
  copy: "M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z",
  edit: "M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z",
  trash: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
  send: "M12 19l9 2-9-18-9 18 9-2zm0 0v-8",
};

/* ---------- Secret card ---------- */
function SecretCard({ secret, isAdmin, flash, onReply, onSave, onDelete, onPin }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [cardError, setCardError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Draft state is only used while editing; otherwise we always render live data
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);
  const sentTimer = useRef(null);

  const originalImage = secret.imageUrl || "";
  const isPlaceholder = secret.content === PLACEHOLDER;

  useEffect(() => () => clearTimeout(sentTimer.current), []);

  const startEdit = () => {
    setTitle(secret.title);
    setContent(isPlaceholder ? "" : secret.content);
    setImageUrl(originalImage);
    setCardError("");
    setEditing(true);
  };

  // Delete a draft image from Storage only if it was uploaded during this edit session
  const discardDraftImage = (url) => {
    if (url && url !== originalImage) deleteImageByUrl(url);
  };

  const cancelEdit = () => {
    discardDraftImage(imageUrl);
    setEditing(false);
    setCardError("");
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again
    if (!file) return;
    if (!file.type.startsWith("image/")) { setCardError("Please choose an image file."); return; }
    if (file.size > MAX_IMAGE_MB * 1024 * 1024) { setCardError(`Image must be smaller than ${MAX_IMAGE_MB} MB.`); return; }

    setUploading(true); setCardError("");
    try {
      const formData = new FormData();
      formData.append("image", file);

      const response = await fetch(`https://api.imgbb.com/1/upload?key=2166816880e7d95d3a1fccc6a40a0a2b`, {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error?.message || "Upload failed");
      }

      discardDraftImage(imageUrl); // replaced an earlier unsaved upload
      setImageUrl(data.data.url);
    } catch (err) {
      console.error("Upload error:", err);
      setCardError("Could not upload the image. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  };

  const removeImage = () => { discardDraftImage(imageUrl); setImageUrl(""); };

  const save = async () => {
    setSaving(true); setCardError("");
    try {
      await onSave(secret, {
        title: title.trim() || secret.title,
        content: content.trim() || PLACEHOLDER,
        imageUrl,
        isPinned: secret.isPinned || false,
      });
      if (originalImage && originalImage !== imageUrl) deleteImageByUrl(originalImage);
      setEditing(false);
    } catch (err) {
      console.error("Save error:", err);
      setCardError("Could not save changes. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setCardError("");
    try {
      await onReply(secret, t);
      setText(""); setReplying(false); setSent(true);
      clearTimeout(sentTimer.current);
      sentTimer.current = setTimeout(() => setSent(false), 3000);
    } catch (err) {
      console.error("Reply error:", err);
      setCardError("Could not send your message. Try again.");
    }
  };

  return (
    <article id={`secret-${secret.id}`}
      className={`glass overflow-hidden p-5 sm:p-6 scroll-mt-24 ${flash ? "animate-flash" : ""}`}>
      {originalImage && !editing && (
        <div className="mb-4 -mx-5 -mt-5 sm:-mx-6 sm:-mt-6 border-b border-red-900/30">
          <img src={originalImage} alt={secret.title} loading="lazy" className="w-full object-cover max-h-[300px]" />
        </div>
      )}

      <div className="flex items-start justify-between gap-3">
        {editing ? (
          <input className="field font-serif text-lg" value={title} maxLength={80}
            aria-label="Title" onChange={(e) => setTitle(e.target.value)} />
        ) : (
          <h2 className="font-serif text-2xl font-semibold text-gold">{secret.title}</h2>
        )}
        {isAdmin && !editing && (
          <div className="flex gap-2 shrink-0">
            <button className="btn-ghost" onClick={startEdit}>Edit</button>
            <button className={`btn-ghost ${secret.isPinned ? "text-gold border-gold/50" : ""}`} onClick={() => onPin(secret)}>
              {secret.isPinned ? "📌 Pinned" : "📌 Pin"}
            </button>
            <button className="btn-ghost hover:!border-red-500 hover:!text-red-400"
              onClick={() => setDeleteConfirm(true)}>Delete</button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          {imageUrl && (
            <div className="space-y-2">
              <div className="rounded-xl overflow-hidden border border-red-900/30">
                <img src={imageUrl} alt="Preview" className="w-full object-cover max-h-[200px]" />
              </div>
              {/* Always-visible button: hover-only overlays don't work on touch screens */}
              <button className="btn-ghost w-full hover:!border-red-500 hover:!text-red-400" onClick={removeImage} disabled={uploading}>
                Remove image
              </button>
            </div>
          )}
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="btn-ghost w-full">
            {uploading ? "Uploading…" : imageUrl ? "Change image" : "Add image"}
          </button>
          <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageUpload} />
          <textarea rows={5} className="field" value={content} placeholder={PLACEHOLDER}
            aria-label="Secret text" onChange={(e) => setContent(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={cancelEdit} disabled={saving}>Cancel</button>
            <button className="btn-red" onClick={save} disabled={saving || uploading}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      ) : (
        <p className={`mt-3 font-serif text-lg leading-relaxed whitespace-pre-wrap ${isPlaceholder ? "italic text-red-100/40" : "text-red-50/90"}`}>
          {secret.content}
        </p>
      )}

      {cardError && <p role="alert" className="mt-3 text-sm text-red-400">{cardError}</p>}

      {!editing && (
        <div className="mt-5 border-t border-red-900/30 pt-4">
          {replying ? (
            <div className="space-y-2">
              <textarea autoFocus rows={3} className="field" maxLength={MAX_MESSAGE_LEN}
                placeholder="Say what this makes you think or feel…"
                value={text} onChange={(e) => setText(e.target.value)} />
              <div className="flex gap-2 justify-end">
                <button className="btn-ghost" onClick={() => { setReplying(false); setText(""); }}>Cancel</button>
                <button className="btn-red" disabled={!text.trim()} onClick={send}>Send to chat</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <button className="btn-ghost" onClick={() => setReplying(true)}>Reply / Express thoughts</button>
              {sent && <span role="status" className="text-sm text-gold">Sent to the chat ♥</span>}
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation modal for secret */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setDeleteConfirm(false)}>
          <div className="glass w-full max-w-sm space-y-4 bg-[#1a0b0b]/95 p-6 rounded-2xl shadow-2xl border border-red-900/20 animate-in zoom-in duration-200"
            onClick={(e) => e.stopPropagation()}>
            <h3 className="font-serif text-xl text-gold">Delete "{secret.title}"?</h3>
            <p className="text-red-100/70">This action cannot be undone.</p>
            <div className="flex justify-end gap-3 pt-2">
              <button className="btn-ghost" onClick={() => setDeleteConfirm(false)}>Cancel</button>
              <button className="btn-red" onClick={() => onDelete(secret)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

/* ---------- Chat drawer ---------- */
function ChatDrawer({ open, onClose, messages, role, onSend, onJump, onReact, onDelete, onEdit, secretsById, typingStatus, onTyping, onlineStatus }) {
  const [text, setText] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [menuId, setMenuId] = useState(null);
  const [chatError, setChatError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [chatBackground, setChatBackground] = useState(() => safeStore.get(localStorage, "jbu_chat_bg") || "default");
  const endRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const stickToBottom = useRef(true);

  // Always look the message up live, so reactions/edits never act on a stale copy
  const menuMsg = menuId ? messages.find((m) => m.id === menuId) : null;

  const emojiMap = [
    { emoji: "❤️", names: ["heart", "love", "red heart"] },
    { emoji: "😂", names: ["joy", "laugh", "lol", "funny", "haha"] },
    { emoji: "🥰", names: ["love", "hearts", "smiling", "adore"] },
    { emoji: "🔥", names: ["fire", "hot", "lit", "flame"] },
    { emoji: "😭", names: ["cry", "sob", "sad", "crying"] },
    { emoji: "👍", names: ["thumbsup", "like", "ok", "yes", "good"] },
    { emoji: "😮", names: ["wow", "surprised", "shocked", "open mouth"] },
    { emoji: "😢", names: ["sad", "tear", "cry"] },
    { emoji: "😍", names: ["heart eyes", "love", "crush"] },
    { emoji: "🤣", names: ["rofl", "rolling", "laugh", "lmao"] },
    { emoji: "💯", names: ["100", "hundred", "perfect", "score"] },
    { emoji: "🎉", names: ["party", "celebrate", "tada", "congrats"] },
    { emoji: "🙏", names: ["pray", "please", "thanks", "hope"] },
    { emoji: "💪", names: ["strong", "muscle", "flex", "power"] },
    { emoji: "😊", names: ["smile", "happy", "blush"] },
    { emoji: "🤔", names: ["think", "thinking", "hmm", "wonder"] },
    { emoji: "👀", names: ["eyes", "look", "see", "watch"] },
    { emoji: "✨", names: ["sparkle", "stars", "shine", "magic"] },
    { emoji: "💕", names: ["hearts", "love", "two hearts"] },
    { emoji: "😇", names: ["angel", "innocent", "halo", "blessed"] },
    { emoji: "😘", names: ["kiss", "blow kiss", "mwah"] },
    { emoji: "🤗", names: ["hug", "hugging", "warm"] },
    { emoji: "😏", names: ["smirk", "flirt", "sly"] },
    { emoji: "🥺", names: ["pleading", "puppy", "please", "cute"] },
    { emoji: "😤", names: ["angry", "mad", "huff", "frustrated"] },
    { emoji: "🤭", names: ["oops", "giggle", "tehe", "hand over mouth"] },
    { emoji: "💔", names: ["broken heart", "heartbreak", "sad"] },
    { emoji: "💋", names: ["lips", "kiss", "smooch"] },
    { emoji: "🌹", names: ["rose", "flower", "romantic"] },
    { emoji: "🦋", names: ["butterfly", "pretty", "flutter"] },
    { emoji: "🌙", names: ["moon", "night", "crescent"] },
    { emoji: "⭐", names: ["star", "favorite", "gold"] },
    { emoji: "🍕", names: ["pizza", "food", "yummy"] },
    { emoji: "☕", names: ["coffee", "tea", "drink", "morning"] },
    { emoji: "🎵", names: ["music", "note", "song", "melody"] },
    { emoji: "📸", names: ["camera", "photo", "picture"] },
    { emoji: "💤", names: ["sleep", "zzz", "tired", "sleepy"] },
    { emoji: "🤝", names: ["handshake", "deal", "agree"] },
    { emoji: "👏", names: ["clap", "bravo", "applause"] },
    { emoji: "😴", names: ["sleeping", "tired", "zzz", "nap"] },
  ];
  const commonEmojis = emojiMap.map((e) => e.emoji);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showBgMenu, setShowBgMenu] = useState(false);
  const [emojiFilter, setEmojiFilter] = useState("");
  const bgMenuRef = useRef(null);

  const backgrounds = {
    default: { className: "bg-[#0f0505]", label: "Default" },
    warmDark: { className: "bg-gradient-to-br from-[#1a0b0b] to-[#2d1818]", label: "Warm Dark" },
    purple: { className: "bg-gradient-to-br from-[#0a0505] to-[#1a0a1a]", label: "Purple Mist" },
    teal: { className: "bg-gradient-to-br from-[#1a0505] to-[#0a1a1a]", label: "Teal Night" },
    midnight: { className: "bg-gradient-to-b from-[#0d0d2b] to-[#1a0a0a]", label: "Midnight" },
    rose: { className: "bg-gradient-to-br from-[#2d0a0a] to-[#1a0505]", label: "Deep Rose" },
    starry: { className: "bg-gradient-to-b from-[#0a0a2a] via-[#150520] to-[#0a0a0a]", label: "Starry" },
    ember: { className: "bg-gradient-to-br from-[#1f0a00] via-[#0f0505] to-[#1a0505]", label: "Ember" },
  };

  const changeBackground = (bg) => {
    setChatBackground(bg);
    safeStore.set(localStorage, "jbu_chat_bg", bg);
    setShowBgMenu(false);
  };

  // Close bg menu on outside click
  useEffect(() => {
    if (!showBgMenu) return;
    const handler = (e) => {
      if (bgMenuRef.current && !bgMenuRef.current.contains(e.target)) setShowBgMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBgMenu]);

  const filteredEmojis = emojiFilter
    ? emojiMap.filter((e) => e.names.some((n) => n.includes(emojiFilter.toLowerCase()))).map((e) => e.emoji)
    : commonEmojis;

  // Reset transient UI when the drawer closes
  useEffect(() => {
    if (!open) { setMenuId(null); setEditingId(null); setChatError(""); setSearchQuery(""); setShowEmojiPicker(false); setDeleteConfirmId(null); setReplyTo(null); }
  }, [open]);

  // Lock page scroll while the drawer is open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Escape closes the top-most layer first
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (menuId) setMenuId(null);
      else if (editingId) setEditingId(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, menuId, editingId, onClose]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      // Ctrl+K: Focus search
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (open) {
          const searchInput = document.querySelector('input[placeholder="Search messages..."]');
          searchInput?.focus();
        }
      }
      // Ctrl+/: Toggle help
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        alert("Keyboard shortcuts:\nCtrl+K: Search messages\nEsc: Close drawer/Cancel");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Jump to the bottom instantly when opened
  useEffect(() => {
    if (!open) return;
    stickToBottom.current = true;
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "auto" }));
  }, [open]);

  // Follow new messages only if the reader is already near the bottom (or sent it)
  useEffect(() => {
    if (!open) return;
    const last = messages[messages.length - 1];
    if (stickToBottom.current || last?.sender === role) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages.length, open, role]); // eslint-disable-line react-hooks/exhaustive-deps

  const onListScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Auto-grow the message box
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setText(""); setChatError("");
    try {
      await onSend(t, replyTo);
      setReplyTo(null);
    }
    catch (err) {
      console.error("Send error:", err);
      setText((cur) => cur || t); // restore so nothing is lost
      setChatError("Message was not sent. Try again.");
    }
  };

  const handleEditSubmit = async (id) => {
    const t = editText.trim();
    if (!t) return;
    setChatError("");
    try {
      await onEdit(id, t);
      setEditingId(null); setEditText("");
    } catch (err) {
      console.error("Edit error:", err);
      setChatError("Could not edit the message. Try again.");
    }
  };

  const handleDelete = async (id) => {
    setMenuId(null);
    try { await onDelete(id); }
    catch (err) { console.error("Delete error:", err); setChatError("Could not delete the message."); }
  };

  const isEnter = (e) => e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;

  // Emoji autocomplete
  const handleEmojiInsert = (emoji) => {
    const beforeColon = text.slice(0, text.lastIndexOf(":"));
    setText(beforeColon + emoji);
    setEmojiFilter("");
    inputRef.current?.focus();
  };

  // Detect emoji autocomplete trigger — show when user types : followed by letters (no space)
  const lastColonIndex = text.lastIndexOf(":");
  const afterColon = lastColonIndex >= 0 ? text.slice(lastColonIndex + 1) : "";
  const showEmojiAutocomplete = lastColonIndex >= 0 && /^[a-zA-Z]*$/.test(afterColon) && afterColon.length <= 20;

  let lastDay = "";

  const filteredMessages = searchQuery
    ? messages.filter((m) => m.text.toLowerCase().includes(searchQuery.toLowerCase()))
    : messages;

  return (
    <>
      <div onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity ${open ? "opacity-100" : "pointer-events-none opacity-0"}`} />

      {/* `invisible` when closed removes the hidden drawer from tab order and screen readers */}
      <aside role="dialog" aria-modal="true" aria-label="Chat"
        className={`fixed right-0 top-0 z-50 flex h-full w-full sm:w-[420px] flex-col border-l border-red-900/30 ${backgrounds[chatBackground]?.className || backgrounds.default.className} transition-[transform,visibility] duration-300 ${open ? "visible translate-x-0" : "invisible translate-x-full"}`}>
        <header className="flex items-center justify-between border-b border-red-900/30 px-5 py-4 pt-[max(1rem,env(safe-area-inset-top))] bg-[#1a0b0b]/80 backdrop-blur-md">
          <div>
            <h2 className="font-serif text-2xl text-gold">Between us</h2>
            {onlineStatus && onlineStatus[role === "admin" ? "her" : "admin"] && (
              <p className="text-xs text-gold/70">
                {role === "admin" ? "Rayhona" : "Sardor"} is online
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost !px-3" onClick={() => setShowBgMenu(!showBgMenu)} title="Change background">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
            </button>
            <button className="btn-ghost !px-3" onClick={onClose}>Close</button>
          </div>
        </header>

        {/* Background menu */}
        {showBgMenu && (
          <div ref={bgMenuRef} className="absolute top-16 right-3 z-[60] bg-[#1a0b0b]/95 backdrop-blur-md rounded-2xl shadow-2xl border border-red-900/20 p-4 animate-in fade-in duration-200 w-[260px]">
            <p className="text-xs text-gold/70 font-medium mb-3">Chat Background</p>
            <div className="grid grid-cols-4 gap-2">
              {Object.entries(backgrounds).map(([key, { className: bgClass, label }]) => (
                <button
                  key={key}
                  onClick={() => changeBackground(key)}
                  className={`flex flex-col items-center gap-1 group`}
                  title={label}
                >
                  <div className={`w-12 h-12 rounded-xl border-2 transition-all ${chatBackground === key ? "border-gold shadow-[0_0_8px_rgba(201,162,75,0.4)]" : "border-white/10 hover:border-white/30"} ${bgClass}`} />
                  <span className={`text-[9px] transition-colors ${chatBackground === key ? "text-gold" : "text-white/40 group-hover:text-white/60"}`}>{label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div ref={listRef} onScroll={onListScroll}
          className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-6 scrollbar-hide">
          <div className={`sticky top-0 z-10 backdrop-blur-sm pb-3 border-b border-red-900/20 ${chatBackground === "default" ? "bg-[#0f0505]/95" : "bg-black/40"}`}>
            <input
              type="text"
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="field !rounded-xl !py-2 !px-3 !text-sm w-full"
            />
          </div>
          {filteredMessages.length === 0 && (
            <p className="mt-10 text-center font-serif text-lg italic text-red-100/30">
              {searchQuery ? "No messages found." : "Nothing here yet."}
            </p>
          )}

          {filteredMessages.map((m) => {
            const mine = m.sender === role;
            const reactions = Object.entries(m.reactions || {}).filter(([, senders]) => senders?.length > 0);
            const isEditing = editingId === m.id;
            const linked = m.secretId ? secretsById.get(m.secretId) : null;
            const time = ts(m);
            const day = new Date(time).toDateString();
            const showDay = day !== lastDay;
            lastDay = day;

            return (
              <div key={m.id}>
                {showDay && (
                  <div className="my-3 text-center">
                    <span className="rounded-full bg-white/5 px-3 py-1 text-[11px] text-red-100/50">{dayLabel(time)}</span>
                  </div>
                )}
                <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
                  <div
                    tabIndex={0}
                    aria-haspopup="menu"
                    onClick={(e) => { e.stopPropagation(); if (!isEditing) setMenuId(m.id); }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if ((e.key === "Enter" || e.key === " ") && !isEditing) { e.preventDefault(); setMenuId(m.id); }
                    }}
                    className={`group relative max-w-[85%] cursor-pointer rounded-2xl px-3.5 py-2 text-[15px] transition-all active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold ${mine ? "bg-crimson text-white rounded-br-none shadow-lg shadow-red-950/20" : "bg-white/10 border border-white/5 text-red-50 rounded-bl-none"}`}>

                    {/* Reply context: tap to jump to the secret (if it still exists) */}
                    {m.secretId && (
                      linked ? (
                        <button type="button"
                          onClick={(e) => { e.stopPropagation(); onJump(m.secretId); }}
                          className="mb-1.5 flex w-full items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5 text-left text-[11px] text-gold/90 border-l-2 border-gold/50 hover:bg-black/30">
                          <span className="font-medium truncate max-w-[180px]">{linked.title}</span>
                          <span aria-hidden="true" className="ml-auto opacity-60">↗</span>
                        </button>
                      ) : (
                        <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5 text-[11px] text-gold/50 border-l-2 border-gold/30">
                          <span className="font-medium truncate max-w-[150px]">{m.secretTitle}</span>
                          <span className="italic opacity-70">(removed)</span>
                        </div>
                      )
                    )}

                    {/* Reply to message context */}
                    {m.replyTo && (
                      <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-black/20 px-2 py-1.5 text-left text-[11px] text-gold/70 border-l-2 border-gold/30">
                        <span className="font-medium">{m.replyTo.sender === role ? "You" : (m.replyTo.sender === "admin" ? "Sardor" : "Rayhona")}</span>
                        <span className="opacity-70 truncate max-w-[150px]">{m.replyTo.text}</span>
                      </div>
                    )}

                    {/* Message Content / Edit Input */}
                    {isEditing ? (
                      <div className="flex items-center gap-2 py-1 min-w-[200px]" onClick={(e) => e.stopPropagation()}>
                        <textarea autoFocus className="field !bg-black/20 !rounded-lg !text-sm flex-1 min-h-[36px] max-h-[100px] py-1.5 px-2" value={editText} onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleEditSubmit(m.id); } if (e.key === "Escape") setEditingId(null); }} />
                        <div className="flex gap-1 shrink-0">
                          <button className="h-8 w-8 flex items-center justify-center bg-gold text-[#0f0505] rounded-full hover:scale-105 active:scale-95 transition-all shadow-md" onClick={() => handleEditSubmit(m.id)} title="Save">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
                          </button>
                          <button className="h-8 w-8 flex items-center justify-center bg-white/10 text-white/60 rounded-full hover:scale-105 active:scale-95 transition-all" onClick={() => setEditingId(null)} title="Cancel">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M6 18L18 6M6 6l12 12"></path></svg>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-end gap-2 flex-wrap">
                        <p className="whitespace-pre-wrap break-words leading-[1.4]">{m.text}</p>
                        <div className="flex items-center gap-1 ml-auto pt-1 group relative">
                          {m.edited && <span className="text-[9px] opacity-50 italic">edited</span>}
                          {mine && m.readAt && (
                            <span className="text-[9px] text-gold" title="Read">
                              ✓✓
                            </span>
                          )}
                          <span className="text-[10px] opacity-60 cursor-help hover:opacity-100 transition-opacity">
                            {new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
                          </span>
                          {/* Tooltip on hover */}
                          <div className="absolute bottom-full right-0 mb-2 px-2 py-1 bg-black/90 text-white text-[10px] rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                            {new Date(time).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                          </div>
                        </div>
                      </div>
                    )}

                    {reactions.length > 0 && (
                      <div className={`mt-1.5 flex flex-wrap gap-1 ${mine ? "justify-end" : "justify-start"}`}>
                        {reactions.map(([emoji, senders]) => (
                          <button key={emoji} onClick={(e) => { e.stopPropagation(); onReact(m, emoji); }}
                            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-all hover:scale-110 border ${senders.includes(role) ? "bg-gold/20 border-gold/40 text-gold" : "bg-white/5 border-white/10 text-white/70"}`}>
                            <span>{emoji}</span>
                            <span className="text-[9px] font-bold">{senders.length}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        {chatError && (
          <div className="bg-[#1a0b0b] px-4 py-2 border-t border-red-900/10">
            <p role="alert" className="text-[12px] text-red-400 font-medium flex items-center gap-2">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd"></path></svg>
              {chatError}
            </p>
          </div>
        )}

        <footer className={`flex flex-col gap-2 border-t border-red-900/20 p-3 pb-[max(1rem,env(safe-area-inset-bottom))] ${chatBackground === "default" ? "bg-[#1a0b0b]" : "bg-black/40"}`}>
          {typingStatus && typingStatus[role === "admin" ? "her" : "admin"] && (
            <div className="text-xs text-gold/70 px-1">
              {role === "admin" ? "Rayhona" : "Sardor"} is typing...
            </div>
          )}
          {replyTo && (
            <div className="flex items-center gap-2 px-2 py-1 bg-black/20 rounded-lg">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-gold/70">Replying to {replyTo.sender === role ? "yourself" : (replyTo.sender === "admin" ? "Sardor" : "Rayhona")}</p>
                <p className="text-xs text-red-50/70 truncate">{replyTo.text}</p>
              </div>
              <button className="text-red-400 hover:text-red-300 px-1" onClick={() => setReplyTo(null)}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 relative">
            <textarea ref={inputRef} rows={1} className="field !rounded-2xl max-h-32 resize-none py-2.5 px-4 overflow-hidden leading-[1.4]" placeholder="Message..." value={text}
              onChange={(e) => {
                setText(e.target.value);
                onTyping(e.target.value);
                // Check for emoji autocomplete trigger
                const val = e.target.value;
                const lastColon = val.lastIndexOf(":");
                if (lastColon >= 0) {
                  const afterColon = val.slice(lastColon + 1);
                  setEmojiFilter(afterColon);
                } else {
                  setEmojiFilter("");
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
                if (e.key === "Escape") { setEmojiFilter(""); }
              }} />
            <button className="h-10 w-10 flex items-center justify-center rounded-full bg-crimson text-white hover:bg-red-500 disabled:opacity-40 transition-all hover:scale-105 active:scale-95 shrink-0"
              disabled={!text.trim()} onClick={submit}>
              <Icon d={ICONS.send} className="w-5 h-5 rotate-45 -translate-x-px -translate-y-px" strokeWidth={2.5} />
            </button>

            {/* Emoji autocomplete dropdown */}
            {showEmojiAutocomplete && filteredEmojis.length > 0 && (
              <div className="absolute bottom-full left-0 mb-2 bg-[#1a0b0b]/95 backdrop-blur-md rounded-xl shadow-2xl border border-red-900/20 p-2 animate-in fade-in duration-150 z-50 max-w-[300px]">
                {afterColon.length > 0 && (
                  <p className="text-[10px] text-gold/50 px-2 pb-1.5 border-b border-red-900/10 mb-1.5">
                    :{afterColon} — {filteredEmojis.length} result{filteredEmojis.length !== 1 ? "s" : ""}
                  </p>
                )}
                {afterColon.length === 0 && (
                  <p className="text-[10px] text-white/30 px-2 pb-1.5 border-b border-red-900/10 mb-1.5">
                    Type to search emoji…
                  </p>
                )}
                <div className={`${afterColon.length > 0 ? "flex flex-col gap-0.5" : "grid grid-cols-7 gap-0.5"} max-h-48 overflow-y-auto scrollbar-hide`}>
                  {(afterColon.length > 0 ? filteredEmojis.slice(0, 8) : filteredEmojis.slice(0, 28)).map((emoji) => {
                    const entry = emojiMap.find((e) => e.emoji === emoji);
                    return afterColon.length > 0 ? (
                      <button
                        key={emoji}
                        onClick={() => handleEmojiInsert(emoji)}
                        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg hover:bg-white/10 transition-colors text-left"
                      >
                        <span className="text-xl">{emoji}</span>
                        <span className="text-xs text-white/50">{entry?.names[0]}</span>
                      </button>
                    ) : (
                      <button
                        key={emoji}
                        onClick={() => handleEmojiInsert(emoji)}
                        className="text-xl hover:scale-110 active:scale-90 transition-transform p-1 rounded hover:bg-white/10"
                        title={entry?.names[0]}
                      >
                        {emoji}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </footer>
      </aside>

      {/* Message actions: bottom sheet on mobile, centered on desktop */}
      {open && menuMsg && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setMenuId(null)}>
          <div role="menu" className="w-full max-w-sm bg-[#1a0b0b] rounded-t-3xl sm:rounded-2xl overflow-hidden animate-slide-up sm:animate-in sm:zoom-in shadow-2xl border border-red-900/20"
            onClick={(e) => e.stopPropagation()}>
            <div className="h-1.5 w-12 bg-white/10 rounded-full mx-auto my-3 sm:hidden" />
            <div className="flex justify-around p-4 border-b border-red-900/20 bg-white/5">
              {showEmojiPicker ? (
                <div className="grid grid-cols-5 gap-2 w-full">
                  {commonEmojis.map((emoji) => (
                    <button key={emoji} onClick={() => { onReact(menuMsg, emoji); setMenuId(null); }}
                      className="text-2xl hover:scale-125 active:scale-90 transition-transform">
                      {emoji}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  {commonEmojis.slice(0, 6).map((emoji) => (
                    <button key={emoji} onClick={() => { onReact(menuMsg, emoji); setMenuId(null); }}
                      className="text-3xl hover:scale-125 active:scale-90 transition-transform px-2">
                      {emoji}
                    </button>
                  ))}
                  <button onClick={() => setShowEmojiPicker(true)}
                    className="text-2xl hover:scale-125 active:scale-90 transition-transform px-2 text-gold">
                    +{commonEmojis.length - 6}
                  </button>
                </>
              )}
            </div>
            <div className="flex flex-col py-2 px-2">
              <button role="menuitem" onClick={async () => { await copyText(menuMsg.text); setMenuId(null); }}
                className="flex items-center gap-4 w-full px-5 py-4 text-base hover:bg-white/10 rounded-xl transition-colors text-left text-red-50">
                <Icon d={ICONS.copy} className="w-5 h-5 text-gold" />
                Copy text
              </button>
              <button role="menuitem" onClick={() => { setReplyTo(menuMsg); setMenuId(null); inputRef.current?.focus(); }}
                className="flex items-center gap-4 w-full px-5 py-4 text-base hover:bg-white/10 rounded-xl transition-colors text-left text-red-50 border-t border-red-900/10">
                <svg className="w-5 h-5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
                Reply
              </button>
              {menuMsg.sender === role && (
                <>
                  <button role="menuitem" onClick={() => { setEditingId(menuMsg.id); setEditText(menuMsg.text); setMenuId(null); }}
                    className="flex items-center gap-4 w-full px-5 py-4 text-base hover:bg-white/10 rounded-xl transition-colors text-left text-red-50 border-t border-red-900/10">
                    <Icon d={ICONS.edit} className="w-5 h-5 text-gold" />
                    Edit message
                  </button>
                  <button role="menuitem" onClick={() => { setDeleteConfirmId(menuMsg.id); setMenuId(null); }}
                    className="flex items-center gap-4 w-full px-5 py-4 text-base hover:bg-red-500/20 text-red-400 rounded-xl transition-colors text-left border-t border-red-900/10">
                    <Icon d={ICONS.trash} className="w-5 h-5" />
                    Delete
                  </button>
                </>
              )}
            </div>
            <div className="h-[env(safe-area-inset-bottom)] sm:hidden" />
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setDeleteConfirmId(null)}>
          <div className="glass w-full max-w-sm space-y-4 bg-[#1a0b0b]/95 p-6 rounded-2xl shadow-2xl border border-red-900/20 animate-in zoom-in duration-200"
            onClick={(e) => e.stopPropagation()}>
            <h3 className="font-serif text-xl text-gold">Delete message?</h3>
            <p className="text-red-100/70">This action cannot be undone.</p>
            <div className="flex justify-end gap-3 pt-2">
              <button className="btn-ghost" onClick={() => setDeleteConfirmId(null)}>Cancel</button>
              <button className="btn-red" onClick={async () => {
                await handleDelete(deleteConfirmId);
                setDeleteConfirmId(null);
              }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- App ---------- */
export default function App() {
  const [secrets, setSecrets] = useState([]);
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [isAdmin, setIsAdmin] = useState(() => safeStore.get(sessionStorage, "jbu_admin") === "1");
  const [chatOpen, setChatOpen] = useState(false);
  const [passOpen, setPassOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [passErr, setPassErr] = useState(false);
  const [flashId, setFlashId] = useState(null);
  const [addingSecret, setAddingSecret] = useState(false);
  const [typingStatus, setTypingStatus] = useState({ admin: false, her: false });
  const [onlineStatus, setOnlineStatus] = useState({ admin: false, her: false });
  const [newMessageNotif, setNewMessageNotif] = useState(null);
  const role = isAdmin ? "admin" : "her";
  const seenKey = `jbu_seen_${role}`;
  const [lastSeen, setLastSeen] = useState(() => Number(safeStore.get(localStorage, seenKey) || 0));
  const seeded = useRef(false);
  const taps = useRef({ n: 0, t: null });
  const flashTimer = useRef(null);
  const typingTimeout = useRef(null);
  const notifTimer = useRef(null);

  useEffect(() => () => { clearTimeout(taps.current.t); clearTimeout(flashTimer.current); }, []);

  // Live listener: secrets (+ one-time seed of Secret #1–#6 on a brand-new database)
  useEffect(() => {
    const seed = async () => {
      try {
        const metaRef = doc(db, "meta", "init");
        if ((await getDoc(metaRef)).exists()) return; // already seeded once; don't re-create deleted secrets
        const batch = writeBatch(db);
        for (let i = 1; i <= 6; i++) {
          batch.set(doc(db, "secrets", `secret-${i}`), {
            number: i, title: `Secret #${i}`, content: PLACEHOLDER, imageUrl: "", createdAt: serverTimestamp(),
          });
        }
        batch.set(metaRef, { seededAt: serverTimestamp() });
        await batch.commit();
      } catch (e) {
        console.error("Seeding failed:", e);
      }
    };

    const q = query(collection(db, "secrets"), orderBy("number", "asc"));
    return onSnapshot(q, (snap) => {
      setSecrets(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoaded(true);
      if (snap.empty && !snap.metadata.fromCache && !seeded.current) {
        seeded.current = true;
        seed();
      }
    }, (e) => { setError(e.message); setLoaded(true); });
  }, []);

  // Live listener: messages
  useEffect(() => {
    const q = query(collection(db, "messages"), orderBy("createdAt", "asc"));
    return onSnapshot(q,
      (snap) => setMessages(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))),
      (e) => setError(e.message));
  }, []);

  // Live listener: typing status
  useEffect(() => {
    const typingRef = doc(db, "typing", "status");
    return onSnapshot(typingRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        console.log("Typing status received:", data, "My role:", role);
        setTypingStatus({
          admin: data.admin === true,
          her: data.her === true,
        });
      }
    }, (e) => console.error("Typing listener error:", e));
  }, []);

  // Live listener: online status
  useEffect(() => {
    const onlineRef = doc(db, "online", "status");
    return onSnapshot(onlineRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setOnlineStatus({
          admin: data.admin === true,
          her: data.her === true,
        });
      }
    }, (e) => console.error("Online listener error:", e));
  }, []);

  // Set online status on mount, offline on unmount
  useEffect(() => {
    const onlineRef = doc(db, "online", "status");
    const setOnline = async () => {
      try {
        await updateDoc(onlineRef, { [role]: true });
      } catch (e) {
        await setDoc(onlineRef, { [role]: true, admin: false, her: false }, { merge: true });
      }
    };
    const setOffline = async () => {
      try {
        await updateDoc(onlineRef, { [role]: false });
      } catch (e) {
        console.error("Set offline error:", e);
      }
    };

    setOnline();
    window.addEventListener("beforeunload", setOffline);
    return () => {
      window.removeEventListener("beforeunload", setOffline);
      setOffline();
    };
  }, [role]);

  // Per-role unread tracking
  useEffect(() => { setLastSeen(Number(safeStore.get(localStorage, seenKey) || 0)); }, [seenKey]);
  const unread = messages.filter((m) => m.sender !== role && ts(m) > lastSeen).length;
  useEffect(() => {
    if (chatOpen && messages.length) {
      const latest = Math.max(...messages.map(ts));
      safeStore.set(localStorage, seenKey, String(latest)); setLastSeen(latest);

      // Mark messages as read
      messages.forEach((m) => {
        if (m.sender !== role && !m.readAt) {
          updateDoc(doc(db, "messages", m.id), { readAt: serverTimestamp() }).catch(console.error);
        }
      });
    }
  }, [chatOpen, messages, seenKey]);

  // New message notification at top
  useEffect(() => {
    if (!chatOpen && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.sender !== role && ts(lastMsg) > lastSeen) {
        setNewMessageNotif({
          text: lastMsg.text,
          sender: lastMsg.sender,
        });
        clearTimeout(notifTimer.current);
        notifTimer.current = setTimeout(() => setNewMessageNotif(null), 5000);
      }
    }
  }, [messages, chatOpen, lastSeen, role]);

  // Show unread count in the browser tab title
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${APP_TITLE}` : APP_TITLE;
  }, [unread]);

  // Logo: 5 taps → passcode / leave admin
  const logoTap = () => {
    const t = taps.current; clearTimeout(t.t); t.n += 1;
    t.t = setTimeout(() => { t.n = 0; }, 2000);
    if (t.n >= 5) {
      t.n = 0;
      if (isAdmin) { setIsAdmin(false); safeStore.remove(sessionStorage, "jbu_admin"); }
      else { setPass(""); setPassErr(false); setPassOpen(true); }
    }
  };
  const submitPass = (e) => {
    e.preventDefault();
    if (pass === ADMIN_PASSCODE) { setIsAdmin(true); safeStore.set(sessionStorage, "jbu_admin", "1"); setPassOpen(false); }
    else setPassErr(true);
  };

  const sendMessage = useCallback((text, secret, replyToMsg) =>
    addDoc(collection(db, "messages"), {
      text, sender: role, createdAt: serverTimestamp(), readAt: null,
      ...(secret ? { secretId: secret.id, secretTitle: secret.title } : {}),
      ...(replyToMsg ? { replyTo: { id: replyToMsg.id, text: replyToMsg.text, sender: replyToMsg.sender } } : {}),
    }), [role]);

  const closeChat = useCallback(() => setChatOpen(false), []);

  const jumpTo = (id) => {
    setChatOpen(false);
    setTimeout(() => {
      document.getElementById(`secret-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashId(id);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashId(null), 2000);
    }, 300);
  };

  const setTyping = async (isTyping) => {
    const typingRef = doc(db, "typing", "status");
    console.log("Setting typing:", role, isTyping);
    try {
      await updateDoc(typingRef, { [role]: isTyping });
    } catch (e) {
      // Document might not exist yet, create it
      try {
        await setDoc(typingRef, { [role]: isTyping, admin: false, her: false }, { merge: true });
      } catch (err) {
        console.error("Typing status error:", err);
      }
    }
  };

  const handleTyping = useCallback((text) => {
    clearTimeout(typingTimeout.current);
    if (text.trim()) {
      setTyping(true);
      typingTimeout.current = setTimeout(() => setTyping(false), 2000);
    } else {
      setTyping(false);
    }
  }, []);

  const addSecret = async () => {
    if (addingSecret) return; // prevents double-click creating/overwriting the same number
    setAddingSecret(true);
    try {
      const n = secrets.reduce((m, s) => Math.max(m, s.number || 0), 0) + 1;
      await addDoc(collection(db, "secrets"), {
        number: n, title: `Secret #${n}`, content: PLACEHOLDER, imageUrl: "", createdAt: serverTimestamp(),
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setAddingSecret(false);
    }
  };

  const deleteSecret = async (sec) => {
    try {
      await deleteDoc(doc(db, "secrets", sec.id));
      deleteImageByUrl(sec.imageUrl); // don't leave orphaned files in Storage
    } catch (e) { setError(e.message); }
  };

  const togglePin = async (sec) => {
    try {
      await updateDoc(doc(db, "secrets", sec.id), { isPinned: !sec.isPinned });
    } catch (e) { setError(e.message); }
  };

  // arrayUnion/arrayRemove are atomic, so two people reacting at once can't overwrite each other
  const handleReaction = async (message, emoji) => {
    const has = (message.reactions?.[emoji] || []).includes(role);
    try {
      await updateDoc(doc(db, "messages", message.id),
        new FieldPath("reactions", emoji), has ? arrayRemove(role) : arrayUnion(role));
    } catch (e) { setError(e.message); }
  };

  const deleteMessage = (id) => deleteDoc(doc(db, "messages", id));

  const editMessage = (id, newText) =>
    updateDoc(doc(db, "messages", id), { text: newText, edited: true, updatedAt: serverTimestamp() });

  // Visitors don't see unwritten placeholder secrets; the admin sees everything
  const visibleSecrets = isAdmin ? secrets : secrets.filter((s) => s.content !== PLACEHOLDER);
  // Sort: pinned first, then by number
  const sortedSecrets = [...visibleSecrets].sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return (a.number || 0) - (b.number || 0);
  });
  const secretsById = new Map(secrets.map((s) => [s.id, s]));

  return (
    <div className="mx-auto min-h-[100dvh] max-w-2xl px-4 pb-32 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6">
      <header className="py-8 text-center">
        <button onClick={logoTap} aria-label={APP_TITLE} className="select-none font-serif text-4xl font-bold tracking-wide text-gold sm:text-5xl">
          {APP_TITLE}
        </button>
        <p className="mt-2 font-serif text-lg italic text-red-100/60">Some things are only said to one person.</p>
        {isAdmin && <p className="mx-auto mt-4 inline-block rounded-full border border-gold/50 px-3 py-1 text-xs text-gold">Admin mode · tap the logo 5 times to leave</p>}
      </header>

      {/* New message notification banner */}
      {newMessageNotif && (
        <div className="glass mb-4 flex items-center justify-between gap-3 border-gold/50 p-4 animate-in slide-in-from-top duration-300">
          <div className="flex-1">
            <p className="text-sm font-semibold text-gold">
              {newMessageNotif.sender === "admin" ? "Sardor" : "Rayhona"}:
            </p>
            <p className="text-sm text-red-50 truncate">{newMessageNotif.text}</p>
          </div>
          <button className="btn-ghost shrink-0 !px-2 !py-0.5" onClick={() => setNewMessageNotif(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      {error && (
        <div role="alert" className="glass mb-4 flex items-start justify-between gap-3 border-red-500/50 p-4 text-sm text-red-300">
          <span>Firestore error: {error}. Check your Firebase config and Firestore rules.</span>
          <button className="btn-ghost shrink-0 !px-2 !py-0.5" onClick={() => setError("")} aria-label="Dismiss error">✕</button>
        </div>
      )}
      {!loaded && (
        <div className="space-y-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass overflow-hidden p-5 sm:p-6">
              <Skeleton className="h-8 w-3/4 mb-4" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-4 w-5/6 mb-2" />
              <Skeleton className="h-4 w-4/6" />
            </div>
          ))}
        </div>
      )}
      {loaded && !error && visibleSecrets.length === 0 && (
        <p className="mt-10 text-center font-serif text-lg italic text-red-100/40">Nothing has been written here yet.</p>
      )}

      <main className="space-y-5">
        {sortedSecrets.map((s) => (
          <SecretCard key={s.id} secret={s} isAdmin={isAdmin} flash={flashId === s.id}
            onReply={(sec, text) => sendMessage(text, sec)}
            onSave={(sec, data) => updateDoc(doc(db, "secrets", sec.id), data)}
            onDelete={deleteSecret} onPin={togglePin} />
        ))}
        {isAdmin && (
          <button className="btn-red w-full py-3" onClick={addSecret} disabled={addingSecret}>
            {addingSecret ? "Adding…" : "Add a secret"}
          </button>
        )}
      </main>

      {/* Floating heart */}
      <button onClick={() => setChatOpen(true)} aria-label={`Open chat${unread ? `, ${unread} unread` : ""}`}
        className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 z-30 flex h-16 w-16 items-center justify-center rounded-full bg-crimson text-3xl text-white shadow-lg shadow-red-950 animate-heartbeat focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold">
        ♥
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full border border-gold bg-ink px-1.5 text-xs font-semibold text-gold">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      <ChatDrawer open={chatOpen} onClose={closeChat} messages={messages} role={role}
        onSend={(t, replyTo) => sendMessage(t, null, replyTo)} onJump={jumpTo} onReact={handleReaction}
        onDelete={deleteMessage} onEdit={editMessage} secretsById={secretsById}
        typingStatus={typingStatus} onTyping={handleTyping} onlineStatus={onlineStatus} />

      {passOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setPassOpen(false)}>
          <form onSubmit={submitPass} onClick={(e) => e.stopPropagation()} className="glass w-full max-w-sm space-y-3 bg-[#140505]/90 p-6">
            <h2 className="font-serif text-2xl text-gold">Enter passcode</h2>
            <input autoFocus type="password" autoComplete="off" className="field" aria-label="Passcode"
              value={pass} onChange={(e) => { setPass(e.target.value); setPassErr(false); }} />
            {passErr && <p role="alert" className="text-sm text-red-400">That passcode is wrong. Try again.</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setPassOpen(false)}>Cancel</button>
              <button type="submit" className="btn-red">Unlock</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}