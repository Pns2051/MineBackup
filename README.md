# Minecraft Backup System

## Render Optimized Minecraft Backup

This Node.js system streams Minecraft server files via SFTP directly to Google Drive.
It is optimized for **Render Free Tier** by using **zero disk space** and minimal RAM.

### 🚀 Deploy on Render (Free)

1.  **Create a Repo**: Push the generated files to a GitHub/GitLab repository.
2.  **Create Web Service**:
    *   Go to dashboard.render.com
    *   Click **New +** -> **Web Service**.
    *   Connect your repository.
3.  **Settings**:
    *   **Runtime**: Node
    *   **Build Command**: `npm install`
    *   **Start Command**: `npm start`
    *   **Instance Type**: Free
4.  **Environment Variables**:
    *   Add your variables manually in the Render Dashboard (SFTP_HOST, etc.).
    *   **IMPORTANT**: For the `service_account.json`, Render handles files differently.
        *   **Option A (Secret File)**: Use Render's "Secret Files" tab to upload `service_account.json` with that exact name.
        *   **Option B (Env Var)**: Base64 encode your json file and save it as a variable, then add a script to decode it. (Option A is easier).

### ⚡ Keeping it Awake (Free Tier Limitation)

Render Free Tier spins down after 15 minutes of inactivity. To keep your backups running 24/7:

1.  This app has a `/health` endpoint.
2.  Use a free monitoring service like **UptimeRobot** or **Cron-Job.org**.
3.  Create an HTTP monitor pointing to: `https://your-app-name.onrender.com/health`
4.  Set it to ping every 5 minutes. This keeps the web service active so the internal backup scheduler can run.

### Features
*   **Zero-Disk Streaming**: Files go SFTP -> RAM -> Drive. No "Disk Full" errors.
*   **Memory Safe**: Processes one file at a time.
*   **Junk Filter**: Automatically skips `logs`, `cache`, and `crash-reports` folders to save bandwidth.
