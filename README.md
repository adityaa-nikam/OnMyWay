# 🛰️ OnMyWay (OMW) — Real-Time Group Chat & Privacy-First Location Sharing

> **"Share until you arrive."**
> 
> *Voice principles: We say **sharing** and **following**, never **tracking**.*

OnMyWay (OMW) is a hardened, privacy-first coordination platform built for persistent groups and ephemeral guest meetups. It provides passwordless authentication, cryptographic group invitations, persistent conversation history, and opt-in real-time GPS location sharing.

---

## 🔒 Security & Architecture Principles

- **Room & Group Isolation:** Users strictly receive events and messages for groups or rooms they belong to.
- **Authoritative Server Identity:** Sender identity is derived strictly server-side from session authentication. The client cannot forge user IDs or display names.
- **CSWSH Protection:** Socket.IO handshakes strictly validate the `Origin` header against authorized hostnames.
- **Email-Scanner-Proof Magic Links:** Magic link verification lands on an interactive confirmation page that requires an explicit `POST` click, preventing automated enterprise email scanners (Proofpoint, Mimecast) from pre-consuming single-use tokens.
- **Cryptographic Security:** Room tokens and session IDs are generated with `crypto.randomBytes` and compared via `crypto.timingSafeEqual` over SHA-256 hashes.
- **Dual Architecture (Persistent Groups vs. Ephemeral Guest Mode):**
  - **Account-Based Groups:** Backed by SQLite (via `better-sqlite3`) behind a swappable repository layer, with cursor pagination and foreign key cascades.
  - **Guest Mode:** 100% ephemeral in-memory state with **zero database writes**.
- **Location Transparency:** Location sharing is **OFF** by default, visibly indicated with a pulse while active, and purged immediately when stopped.

---

## 🧪 Automated Test Suite & Exact Test Counts

### Test Count Clarification
- **`node test-rooms-security.js`:** **52 assertions passed** (13 test suites).
  > *Note on 45 vs 52 count:* An earlier revision of the README listed 45 checks. When Sections 11–13 were subsequently introduced (Unified Workspace, Shared Rendezvous Point, Ghost Mode & Emergency SOS), 7 new checks were added, bringing the verified runtime assertion total to **52**.
- **`node test-milestone1.js`:** **28 assertions passed** (6 test suites).
- **Total Automated Test Suite:** **80 checks passed**, 0 failures.

### Running Automated Tests
```bash
# Run both test suites
npm test

# Run only Milestone 1 (Auth, DB, CSWSH, Cascades, Persistence)
npm run test:milestone1

# Run only Ephemeral Room Security & Isolation Suite
npm run test:security
```

---

## 📦 New Dependencies

Added for Milestone 1:
- `better-sqlite3`: High-performance, synchronous SQLite3 driver with WAL mode enabled.
- `cookie-parser`: Secure HTTP cookie parsing for session tokens.
- `nodemailer`: SMTP email transport with automatic fallback to local development console logging.

---

## ⚙️ Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port for the HTTP and Socket.IO server |
| `DATABASE_PATH` | `./data/onmyway.db` | SQLite database file location |
| `SESSION_SECRET` | Auto-generated | Secret used for CSRF token entropy |
| `APP_URL` | `http://localhost:3000` | Public URL used to format magic links and group invitations |
| `SMTP_HOST` | *(empty)* | SMTP server host (e.g., `smtp.sendgrid.net`) |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_USER` | *(empty)* | SMTP username |
| `SMTP_PASS` | *(empty)* | SMTP password |
| `SMTP_FROM` | `OnMyWay <noreply@onmyway.app>` | Sender email header |

*Note: In development, when SMTP credentials are not configured, magic sign-in links are printed directly to the terminal console.*

---

## 🗄️ Database Migrations

Database migrations are version-controlled, file-based SQL scripts tracked in the `_migrations` table:
- Migration Directory: `db/migrations/`
- Initial Schema: `db/migrations/001_initial_schema.sql`
- Runner: `node db/migrate.js` (automatically runs on server initialization)

### Schema Entities
1. `users`: User identity, email, display name, avatar URL.
2. `sessions`: SHA-256 hashed session tokens, expiration timestamps (cascades on user deletion).
3. `groups`: Group ID, name, owner ID, retention period.
4. `group_members`: User-group memberships, roles (`owner` / `member`), last read message cursor.
5. `invites`: SHA-256 hashed invite tokens, expiration timestamps, usage limits, use counter.
6. `messages`: Group messages, sender ID, body, reply ID, timestamps (cascades on user or group deletion).
7. `auth_tokens`: Single-use SHA-256 hashed magic link tokens with 15-minute expiration.

---

## 🕹️ Manual Test Steps (Milestone 1)

Follow these steps to test all Milestone 1 features interactively in a browser:

### 1. Passwordless Magic Link & Scanner Defense
1. Open `http://localhost:3000` and click **"Sign In with Magic Link"** (or navigate to `/login`).
2. Enter an email address (e.g. `you@example.com`) and click **"Send Magic Link"**.
3. Check the server console log for the generated link:
   ```text
   🔗 SIGN-IN LINK: http://localhost:3000/auth/verify?token=...
   ```
4. Copy and paste the link into your browser.
5. Notice that you land on the **Sign In Confirmation** page (`GET /auth/verify`). Automated email crawlers cannot log in or consume the token here.
6. Click **"Confirm & Sign In"** (`POST /auth/verify`). You will be redirected to the **"My Groups"** dashboard (`/groups`) with an `omw_session` cookie set.
7. Try opening or refreshing the same verification link in an incognito window: verify that it is rejected as already used.

### 2. Creating and Managing Groups
1. On `/groups`, click **"Create Group"**.
2. Enter a group name (e.g. `"Weekend Hiking Group"`) and submit.
3. You will immediately be redirected to the group's unified workspace (`/groups/g_...`).
4. Notice your identity is automatically derived from your account display name.

### 3. Cryptographic Invites
1. In the group workspace header, click **"Invite Members"**.
2. Choose an expiration (e.g. 1 hour) and a max-use count (e.g. 1 use). Click **"Generate Link"**.
3. Copy the invite link.
4. Open the link in a second browser / incognito profile:
   - If not signed in, you are prompted to authenticate first, and returned seamlessly.
   - Upon authentication, you join the group as a `member`.
5. Try using the invite link a second time: verify that it displays `"Invite Limit Reached"`.

### 4. Chat History & Server Reboot Recovery
1. In the group, send several messages in the chat panel.
2. In your terminal, stop the server (`Ctrl+C`) and restart it (`npm start`).
3. Refresh the group page in your browser.
4. Verify that all previously sent messages are immediately reloaded from the SQLite database.

### 5. Ephemeral Guest Mode (Zero DB Writes)
1. In an incognito tab, navigate to `http://localhost:3000`.
2. Under **"Ephemeral Guest Mode"**, click **"Start Instant Guest Room"**.
3. Confirm that you can share chat messages and follow peer locations.
4. Verify that no records are created in `data/onmyway.db` for this room (guest rooms remain purely in-memory).

### 6. Cascade Account Deletion (GDPR)
1. Go to **Account Settings** (`/account`).
2. Review your active memberships and profile details.
3. Scroll down to the danger zone and click **"Permanently Delete Account"**.
4. Confirm the browser prompt.
5. Verify you are logged out and redirected to `/`.
6. Inspect the database: verify that your user row, active sessions, group memberships, and authored messages have been completely deleted via foreign key cascades.
