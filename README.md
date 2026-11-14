# Read Assist

A reading coach that uses your laptop webcam to follow your reading line by line. It tells you what you read, skimmed or skipped, and uses Google Gemini to summarize anything you missed.

Students read assigned (or their own) readings in a calm, distraction-free reader. Professors see class-wide maps of which passages were skipped or re-read.

> Hackathon demo. Sign-in has no passwords, and data lives in `data/db.json`. Camera video never leaves the browser: only "which words were read" is saved.

---

## How to run it (step by step)

### 1. Open a terminal in this folder

In the Claude app you can use the Terminal panel. Otherwise open the **Terminal** app and run:

```bash
cd ~/Documents/CodingStuff/claudeforfun/read-assist
```

### 2. Install (first time only)

```bash
npm install
```

This also downloads the eye-tracking model into `public/mediapipe/`.

### 3. Add your Gemini API key (optional but recommended)

1. Get a key at https://aistudio.google.com/apikey
2. Open the file `.env.local` in this folder (it's hidden in Finder; open it from your editor).
3. Replace `your-key-here` with your key, so the line reads `GEMINI_API_KEY=AIza...`
4. Save. If the app is already running, stop it (Ctrl + C) and start it again.

Without a key everything still works. Summaries fall back to "first lines of what you missed" and there's no quiz.

### 4. Start the app

```bash
npm run dev
```

Wait for `Ready`, then open **http://localhost:3000** in **Google Chrome**. Chrome is recommended; the camera only works on `localhost` or `https` addresses.

To stop the app, click the terminal and press **Ctrl + C**.

---

## Test it as a student (about 5 minutes)

1. On the sign-in page choose **Student**, type any name and email (e.g. `me@test.edu`) and press **Continue**. You're automatically enrolled in the demo course.
2. Under **Assigned readings**, click **How Your Eyes Actually Read**, then **Start reading**.
3. Click **Turn on camera** and allow camera access when Chrome asks.
4. Wait until all four checks are green (face visible, centered, distance, lighting). If lighting is red, face a lamp or window; don't sit with a window behind you.
5. Click **Calibrate & start**. The app goes full screen.
   - **Look at each dot, then click it** (13 dots). Keep your head roughly still.
   - Then **just look** at 5 more dots (no clicking).
   - You'll get a rating (Great / Okay / Rough). Move your eyes around: a circle should roughly follow your gaze. If it's "Rough", click **Recalibrate**.
6. Click **Start reading** and read normally. Use **→** / **Space** for the next page and **←** to go back.

### Things to try while reading

| Try this | What should happen |
|---|---|
| Press **G** | Debug view: a dot shows where the tracker thinks you're looking, and the line it thinks you're on is softly highlighted. Press G again to hide it. |
| Look away (at your phone) for ~5 seconds, then look back | A soft **"You left off here"** marker sits next to the line you were on. It fades once you're back on that line. |
| While reading, jump ahead ~5 lines and keep reading there | After a couple of seconds, **"Your place was here"** points to where you skipped from. |
| Flip to the next page within a few seconds | A small note at the top: *"Page 1 went by quickly. Want to go back to it?"* |
| Switch to another browser tab and come back | Counted as a distraction in your report. |
| Gear icon (top right) | Change theme (light / dark / sepia), font, text size, turn reading aids off, or recalibrate. |

7. Click **Finish & see report** on the last page, or **Finish session** at the top. After a few seconds you'll see:
   - coverage, focus, reading speed and time
   - a paragraph-by-paragraph strip, and the full text colored by read / skimmed / skipped, with re-read paragraphs marked
   - **What you missed**: Gemini summaries of the skipped parts, plus a 3-question quiz on them
   - a timeline of reading, moving quickly, paused and away

### Upload your own reading

**Upload a reading** (top bar). Paste text, or switch to **Upload PDF** and drop a PDF. Check the extracted text, fix anything odd, then save. With a Gemini key you can tick *"Clean up messy formatting with Gemini"* for tricky PDFs (two columns, lots of headers).

---

## Test it as a professor

1. Sign out (the arrow icon at the top right).
2. Sign in with role **Professor** and email **`prof@demo.edu`** (the demo professor who owns the demo course).
3. Open **PSYC 214** to see the readings, the join code **READ01** and the student list.
4. Click a reading to open **Class insights**: per-student results, a class reading map (which paragraphs many students skipped or re-read), and **Generate** for a Gemini-written class digest.
5. **Post a reading** to assign something new (paste or PDF, optional due date and instructions).
6. **New course** on the dashboard creates a course with its own join code. Students join from their dashboard with **Join a course**.

## Testing with other people

- **Same laptop:** sign out, then sign in with a different email. Everyone gets their own reports, and the professor view combines them.
- **Their own laptop:** the camera only works on `localhost` or `https`. The easiest option is to run the app on their laptop (copy this folder and repeat steps 2–4). They'll have their own separate data.

## Resetting the demo data

Stop the app (Ctrl + C), delete the file `data/db.json`, and start it again. It recreates the demo professor, course and reading.

## Troubleshooting

- **"Camera access was blocked"**: click the camera icon in Chrome's address bar, choose *Allow*, and reload. On macOS also check System Settings → Privacy & Security → Camera → Google Chrome.
- **Calibration says "Rough"**: improve the light on your face, sit about an arm's length away, and try to keep your head still during calibration and reading. Glasses with strong glare can hurt accuracy.
- **The gaze dot drifts after a while**: that's normal for webcams. The app slowly corrects drift on its own; if it gets bad, use gear icon → **Recalibrate**.
- **Gemini errors** (the terminal shows `[gemini] ... failed`): check the key in `.env.local`. If the model name is rejected, add a line like `GEMINI_MODEL=gemini-2.5-flash` (any model listed in Google AI Studio) and restart.

---

## How the eye tracking works (short version)

1. **Face → eye features.** Google's MediaPipe Face Landmarker runs in your browser (WebAssembly + GPU) and finds 478 face points, including both irises. We turn those into ~14 numbers per frame: where each iris sits inside its eye, eye openness and head pose.
2. **Calibration.** While you look at the dots, we learn a personal mapping from those numbers to a screen position. It uses ridge regression, with the strength picked by leave-one-dot-out cross-validation. The 5 validation dots measure your real accuracy.
3. **Which line?** Webcam gaze is only accurate to a few lines, so a *Hidden Markov Model* combines that rough position with how reading works. You stay on a line, and after a big left-jump (a *return sweep*) you're on the next one. It also:
   - learns your calibration drift from the start of every page, since people begin reading at the top line
   - uses short paragraph-ending lines as landmarks
   - treats consecutive webcam frames as weak, correlated evidence, so noise can't overpower the reading-order logic
4. **What did you read?** Each moment's time is spread over the words on the lines you're probably on.
   - **Read:** at least 35% of normal reading time
   - **Skimmed:** 15–35%
   - **Skipped:** less than that
   - **Re-read:** jumping back 2+ lines and staying there, or lingering much longer than your usual pace
5. **Gentle aids.** The tracker never shows anything that moves with your eyes. The bookmark appears only when you look away or skip a block of lines, and fades on its own.

Simulation check: `npm run simulate` feeds a fake reader with noisy, offset gaze through the real tracker. In recent runs, the estimated line was within ±1 of the true line 92–100% of the time, skipped blocks and look-aways were caught with the marker on the right line, and re-reading was detected in 4 of 5 runs.

### Where things live

| Path | What it is |
|---|---|
| `src/lib/gaze/faceTracker.ts` | Camera + MediaPipe → eye features |
| `src/lib/gaze/gazeModel.ts` | Calibration (ridge regression) and accuracy check |
| `src/lib/gaze/lineHmm.ts` | The line-tracking Hidden Markov Model |
| `src/lib/gaze/readingTracker.ts` | Reading states, coverage, re-reads, nudges, final report |
| `src/components/reader/` | Setup, calibration and reader screens |
| `src/lib/gemini.ts` | All Gemini calls (summaries, quiz, class digest, PDF clean-up) |
| `src/lib/pdf.ts` | PDF → clean paragraphs |
| `src/lib/db.ts` | The tiny JSON-file database |
| `scripts/simulate.ts` | Algorithm simulation |
| `PLAN.md` | Original research and feasibility plan |
