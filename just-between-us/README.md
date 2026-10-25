# Just Between Us

## Setup
1. `npm install`
2. Firebase console → create project → add Web app → copy config into `src/firebase.js` (or `.env`, see `.env.example`).
3. Firebase console → Build → Firestore Database → Create database.
4. Set `ADMIN_PASSCODE` at the top of `src/App.jsx`.
5. `npm run dev` (local) · `npm run build` (production, deploy `dist/` to Firebase Hosting / Netlify / Vercel).

## Firestore rules (no login system, so the app is open to anyone with the URL — keep the URL private)
```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /secrets/{id}  { allow read, write: if true; }
    match /messages/{id} { allow read, create: if true; allow update, delete: if false; }
  }
}
```
Note: admin mode is a client-side passcode, so it hides the editing UI but doesn't enforce permissions in Firestore.
For real enforcement, add Firebase Auth and restrict secrets writes to your uid.

## Usage
Tap the logo 5 times → passcode → admin mode. Repeat to leave admin mode.
Secrets #1–#6 are created automatically the first time the app loads against an empty database.
