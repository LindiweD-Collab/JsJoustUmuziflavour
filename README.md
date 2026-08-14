# JS Joust

A phone-as-controller party game. One laptop or TV is the **host**. Everyone else uses their **phone as a sword**. Stay steady when the music allows it, freeze when it stops, and lunge at each other to clash.

Phones must be on **HTTPS** (or localhost) or the browser will not share motion data.

---

## Play in 5 minutes (local)

You need Node.js, a laptop on Wi‑Fi, and phones on the **same Wi‑Fi**.

```bash
npm install
npm start
```

1. On the laptop, open [http://localhost:3000](http://localhost:3000) (this is the host / TV screen).
2. A **room code** and **QR** appear automatically.
3. Players scan the QR (or open `http://<your-laptop-ip>:3000/controller.html` and type the code).
4. Enter a name and tap **Join Game**.
5. **Hold the phone still and upright** until it says READY (white ring on the host orb).
6. Host taps **Start Game**. Turn the laptop volume up — the music *is* the rules.

The terminal prints your local IP if you need it for phones that cannot scan the QR.

---

## How a round works

| What you see / hear | What you do |
|---|---|
| Your phone glows your **orb color** | That is your identity. Watch each other, not the text. |
| Beat ticks + phone buzz | You may joust. Too much idle shaking → you become a **ghost**. |
| **FREEZE** (purple, sting, long buzz) | Do not move. Almost any twitch and you are out. |
| Two people lunge at the same time | **Clash** — the weaker hit becomes a ghost. |
| You go ghost (dim orb) | Stay in. You can still clash and hunt the living. |
| Two players left | **Sudden death** — fastest tempo, nastier freeze. |
| Gold orb + fanfare | Winner. Host taps **Play Again** (names, colors, and win streaks stay). |

**Teams:** on the host, tap **Teams: On** in the lobby. Players split red / blue. Last team with someone alive wins.

If ghosts wipe the last living player, **GHOSTS WIN**.

---

## Deploy on Render (HTTPS)

Phone motion and `wss://` need a real HTTPS URL. Use a Render **Web Service**, not a static site.

| Setting | Value |
|---|---|
| Build | `npm install` |
| Start | `npm start` |
| Health check | `/health` |

After deploy:

1. Open `https://your-app.onrender.com` on the host screen.
2. Players scan the QR — it already points at the HTTPS controller link.
3. Free instances sleep when idle; the first load can take ~30 seconds.

A `render.yaml` is in the repo if you want to wire this as a Blueprint.

---

## Project map

```
server.js                 Game rules, rooms, WebSockets
public/host.html          TV screen + music
public/controller.html    Phone sword
public/css/tokens.css     Shared colors (start here to restyle)
public/css/host.css       Host layout
public/css/controller.css Phone layout
```

The **server** decides who dies. Clients only send motion and show state. Tune feel in `server.js`:

- `STAGES` — BPM and how much movement is allowed
- `FREEZE_THRESHOLD` — how still FREEZE is (default `0.9`)
- `CLASH_WINDOW_MS` — how close two lunges must be (default `80`)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone never sends motion / Join does nothing | Use HTTPS (Render) or localhost. On iPhone, tap Join so motion permission can pop. |
| QR opens a dead link locally | Phones must be on the same Wi‑Fi, not guest isolation. Use the laptop IP printed in the terminal. |
| Have to shake violently to lose | Hard-refresh the phone page so the gravity-stripped motion code loads. |
| WebSocket fails on Render | Confirm it is a Web Service. The page must load as `https://` so the client uses `wss://`. |
| Audio silent | Click **Start Game** on the host (browsers block sound until a click). |
| Player drops forever after a blip | There is no reconnect yet — they rejoin as a new orb. |

---

## Known limits

- A Wi‑Fi blip removes that player from the room.
- Beat clock is good enough for a party, not studio-tight.
- Cheap phones report motion on different scales; playtest and tweak `STAGES` if needed.
