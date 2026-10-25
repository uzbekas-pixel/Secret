/**
 * Real-time presence for "Just Between Us" (Firebase Realtime Database).
 *
 * Data layout (Realtime Database only; Firestore is untouched):
 *
 *   presence/{role}/connections/{connId} = { state: "online", at: <server ts> }
 *   presence/{role}/lastOnline           = <server ts>
 *
 * `role` is the app's established participant identity: "admin" (Sardor) or
 * "her" (Rayhona).
 *
 * Why one record per connection? A person can have several tabs/devices open.
 * Each tab adds its own child under `connections` and removes it on disconnect,
 * so the participant is "online" while at least one child exists. Closing one
 * tab therefore never marks them offline while another tab is still connected.
 * `lastOnline` is refreshed whenever any connection ends and is only shown
 * when no connection remains.
 */
import { useEffect, useState } from "react";
import { getApp } from "firebase/app";
import {
  getDatabase, ref, push, set, remove, onValue, onDisconnect, serverTimestamp,
} from "firebase/database";

const isRole = (r) => r === "admin" || r === "her";

/* ---------- Realtime Database instance (lazy, never throws) ---------- */
let rtdb;
let rtdbResolved = false;

function getRtdb() {
  if (rtdbResolved) return rtdb;
  rtdbResolved = true;
  rtdb = null;
  try {
    const app = getApp(); // the app already initialised in ./firebase
    // Explicit URL only: env var first, then whatever the app config already has.
   const url =
  import.meta.env.VITE_FIREBASE_RTDB_ENDPOINT ||
  import.meta.env.VITE_FIREBASE_DATABASE_URL ||
  app.options.databaseURL;
    if (!url) {
      console.warn(
        "[presence] No Realtime Database URL. Set VITE_FIREBASE_DATABASE_URL " +
        "(or databaseURL in your Firebase config). Presence is disabled."
      );
      return rtdb;
    }
    rtdb = getDatabase(app, url);
  } catch (e) {
    console.error("[presence] Realtime Database init failed:", e);
  }
  return rtdb;
}

/* ---------- Publish MY presence ---------- */
export function useOwnPresence(role) {
  useEffect(() => {
    const db = getRtdb();
    if (!db || !isRole(role)) return undefined;

    const connectedRef = ref(db, ".info/connected");
    const lastOnlineRef = ref(db, `presence/${role}/lastOnline`);
    // One unique child per tab/effect run; reused across reconnects (no duplicates).
    const myConnRef = push(ref(db, `presence/${role}/connections`));
    let cancelled = false;

    const unsubscribe = onValue(connectedRef, async (snap) => {
      if (snap.val() !== true) return; // offline: the server removes our record via onDisconnect
      try {
        // Register server-side cleanup BEFORE announcing ourselves.
        await Promise.all([
          onDisconnect(myConnRef).remove(),
          onDisconnect(lastOnlineRef).set(serverTimestamp()),
        ]);
        if (cancelled) return;
        await Promise.all([
          set(myConnRef, { state: "online", at: serverTimestamp() }),
          set(lastOnlineRef, serverTimestamp()),
        ]);
        // Unmounted / role switched while the writes were in flight: don't leave an orphan.
        if (cancelled) remove(myConnRef).catch(() => {});
      } catch (err) {
        console.error("[presence] Could not publish presence:", err);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      // Cancel only THIS client's pending onDisconnect handlers (other tabs have their own),
      // so a role switch can never later write to the old role's path.
      onDisconnect(myConnRef).cancel().catch(() => {});
      onDisconnect(lastOnlineRef).cancel().catch(() => {});
      remove(myConnRef).catch(() => {});
      set(lastOnlineRef, serverTimestamp()).catch(() => {});
    };
  }, [role]);
}

/* ---------- Derive status from raw data (pure, testable) ---------- */
export function derivePresence({ connected, peer, failed }) {
  if (failed) return { status: "unavailable", lastSeen: null };
  // We can't know anything about the other person until WE are connected
  // and have received the first snapshot (peer === undefined means "not yet").
  if (!connected || peer === undefined) return { status: "connecting", lastSeen: null };
  const conns = peer && peer.connections ? Object.keys(peer.connections).length : 0;
  if (conns > 0) return { status: "online", lastSeen: null };
  const last = peer && typeof peer.lastOnline === "number" ? peer.lastOnline : null;
  return { status: "offline", lastSeen: last };
}

/* ---------- Subscribe to the OTHER participant's presence ---------- */
export function usePeerPresence(peerRole) {
  const [state, setState] = useState({ status: "connecting", lastSeen: null, offset: 0 });

  useEffect(() => {
    const db = getRtdb();
    if (!db || !isRole(peerRole)) {
      setState({ status: "unavailable", lastSeen: null, offset: 0 });
      return undefined;
    }

    let connected = false;
    let peer; // undefined until the first snapshot arrives
    let failed = false;
    let offset = 0;
    const publish = () => setState({ ...derivePresence({ connected, peer, failed }), offset });

    setState({ status: "connecting", lastSeen: null, offset: 0 });

    const unsubs = [
      onValue(ref(db, ".info/connected"), (s) => { connected = s.val() === true; publish(); }),
      onValue(ref(db, ".info/serverTimeOffset"), (s) => { offset = Number(s.val()) || 0; publish(); }),
      onValue(
        ref(db, `presence/${peerRole}`),
        (s) => { peer = s.val(); failed = false; publish(); },
        (err) => { console.error("[presence] Listener error:", err); failed = true; publish(); },
      ),
    ];
    return () => unsubs.forEach((u) => u());
  }, [peerRole]);

  return state;
}

/* ---------- Text ---------- */
const hhmm = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function formatLastSeen(lastSeenMs, nowMs) {
  const diff = Math.max(0, nowMs - lastSeenMs);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const d = new Date(lastSeenMs);
  const now = new Date(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `today at ${hhmm(d)}`;
  if (d.toDateString() === yesterday.toDateString()) return `yesterday at ${hhmm(d)}`;
  const date = d.toLocaleDateString([], {
    day: "numeric", month: "long",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
  return `${date} at ${hhmm(d)}`;
}

export function presenceLabel(name, presence, nowMs = Date.now()) {
  switch (presence?.status) {
    case "online": return `${name} is online`;
    case "offline":
      return presence.lastSeen
        ? `${name} was last seen ${formatLastSeen(presence.lastSeen, nowMs)}`
        : `${name} is offline`;
    case "unavailable": return "Status unavailable";
    default: return "Connecting…";
  }
}