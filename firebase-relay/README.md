# DesktopNote Firebase relay

This narrowly scoped Cloudflare Pages Function relays only the Firebase Auth
operations and the single Firestore workspace path used by DesktopNote. It is
not a general-purpose proxy.

Deploy from this directory with:

```powershell
npx --yes wrangler@4 pages deploy public --project-name speraymer-note-sync-relay
```
