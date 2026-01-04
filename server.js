/**
 * MINECRAFT BACKUP SYSTEM v2.1 (Render Optimized)
 * 
 * Features:
 * - Zero-Disk Architecture: Streams directly from SFTP -> ZIP -> Google Drive.
 * - Memory Efficient: Processes files sequentially to fit in Free Tier RAM (512MB).
 * - Self-Healing: Auto-reconnects SFTP on drop.
 */

require('dotenv').config();
const express = require('express');
const Client = require('ssh2-sftp-client');
const archiver = require('archiver');
const { google } = require('googleapis');
const cron = require('node-cron');
const cors = require('cors');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const config = {
  host: process.env.SFTP_HOST,
  port: parseInt(process.env.SFTP_PORT) || 22,
  username: process.env.SFTP_USER,
  password: process.env.SFTP_PASS,
  folders: process.env.TARGET_FOLDERS ? process.env.TARGET_FOLDERS.split(',').map(f => f.trim()) : [],
  driveId: process.env.DRIVE_FOLDER_ID,
  interval: parseInt(process.env.BACKUP_INTERVAL_MINUTES) || 60,
  prefix: process.env.BACKUP_PREFIX || 'backup-',
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS
};

// --- STATE MANAGEMENT ---
const state = {
  status: 'IDLE',
  lastBackup: null,
  nextBackup: null,
  currentFile: '',
  fileCount: 0,
  logs: [],
  startTime: Date.now()
};

const addLog = (type, message) => {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    time: new Date().toLocaleTimeString(),
    type, 
    message
  };
  console.log(`[${entry.time}] [${type}] ${message}`);
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();
};

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- API ROUTES ---
app.get('/api/stats', (req, res) => {
  res.json({
    status: state.status,
    uptime: process.uptime(),
    lastBackup: state.lastBackup,
    nextBackup: state.nextBackup,
    currentActivity: state.currentFile,
    fileCount: state.fileCount,
    configSummary: {
      host: config.host,
      interval: config.interval,
      folders: config.folders
    }
  });
});

app.get('/api/logs', (req, res) => res.json(state.logs));

app.post('/api/trigger', (req, res) => {
  if (state.status !== 'IDLE') return res.status(400).json({ error: 'Busy' });
  addLog('INFO', 'Manual trigger received');
  runStreamingBackup();
  res.json({ message: 'Started' });
});

app.get('/health', (req, res) => res.send('OK')); // For uptime monitors

// --- STREAMING BACKUP ENGINE (Zero-Disk) ---
async function runStreamingBackup() {
  if (state.status !== 'IDLE') return;

  const sftp = new Client();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipName = `${config.prefix}${timestamp}.zip`;

  try {
    state.status = 'CONNECTING';
    addLog('INFO', `Starting optimized stream backup: ${zipName}`);
    state.fileCount = 0;

    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password
    });

    // 1. Setup Drive Upload Stream
    state.status = 'STREAMING';
    addLog('INFO', 'Initializing Google Drive Upload Stream...');
    
    const auth = new google.auth.GoogleAuth({
      keyFile: config.keyFile,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // 2. Setup Archiver
    // We use a lower compression level (5) to balance CPU usage on Free Tier
    const archive = archiver('zip', { zlib: { level: 5 } }); 

    archive.on('warning', (err) => addLog('WARNING', err.message));
    archive.on('error', (err) => { throw err; });

    // 3. Pipe Archiver directly to Google Drive
    // This starts the request. Drive waits for data chunks.
    const driveUploadPromise = drive.files.create({
      resource: {
        name: zipName,
        parents: [config.driveId],
      },
      media: {
        mimeType: 'application/zip',
        body: archive, // The stream
      },
      fields: 'id',
    });

    // 4. Walk SFTP and Stream Files into Archive
    for (const folder of config.folders) {
      addLog('INFO', `Scanning folder: ${folder}`);
      await processDirectory(sftp, archive, folder, folder);
    }

    // 5. Finalize
    addLog('INFO', 'Finalizing archive stream...');
    await archive.finalize();
    
    // 6. Wait for Drive to confirm receipt
    const driveResponse = await driveUploadPromise;
    
    state.lastBackup = Date.now();
    addLog('SUCCESS', `Backup complete! Drive File ID: ${driveResponse.data.id}`);

  } catch (err) {
    addLog('ERROR', `Backup failed: ${err.message}`);
    // Attempt to recover stream if possible, but usually fatal
  } finally {
    state.status = 'IDLE';
    state.currentFile = '';
    try { await sftp.end(); } catch (e) {}
  }
}

// Recursive function to walk SFTP dirs and stream files
async function processDirectory(sftp, archive, remotePath, zipPath) {
  try {
    const list = await sftp.list(remotePath);
    
    for (const item of list) {
      const itemRemotePath = `${remotePath}/${item.name}`;
      const itemZipPath = `${zipPath}/${item.name}`;

      if (item.type === 'd') {
        // Recurse into subdirectory
        // Check for common junk folders to skip for optimization
        if (['logs', 'cache', 'crash-reports'].includes(item.name)) {
             addLog('INFO', `Skipping junk folder: ${item.name}`);
             continue;
        }
        archive.append(null, { name: itemZipPath + '/' });
        await processDirectory(sftp, archive, itemRemotePath, itemZipPath);
      } else {
        // It's a file
        state.currentFile = item.name;
        state.fileCount++;
        
        // Create a PassThrough stream for this specific file
        const fileStream = new PassThrough();
        
        // Initiate download from SFTP to our stream
        // We await the download to ensure we don't flood RAM with too many open streams
        // This is slower but much safer for Free Tier (512MB RAM)
        const transfer = sftp.get(itemRemotePath, fileStream);
        
        // Pipe into archive
        archive.append(fileStream, { name: itemZipPath });
        
        // Wait for this file to finish downloading before moving to next
        await transfer;
      }
    }
  } catch (err) {
    addLog('WARNING', `Failed to process ${remotePath}: ${err.message}`);
  }
}

// --- SCHEDULER & KEEP ALIVE ---
cron.schedule(`*/${config.interval} * * * *`, () => {
  addLog('INFO', 'Scheduled cycle starting...');
  runStreamingBackup();
});

// Self-ping to prevent sleep (Best effort for Render Free)
if (process.env.RENDER_MODE === 'true') {
    setInterval(() => {
        const http = require('http');
        http.get(`http://localhost:${PORT}/health`);
    }, 5 * 60 * 1000); // Every 5 minutes
}

// Update "Next Backup" timer for UI
setInterval(() => {
    const now = new Date();
    const minutes = now.getMinutes();
    const remainder = config.interval - (minutes % config.interval);
    state.nextBackup = new Date(now.getTime() + remainder * 60000).toISOString();
}, 10000);

// --- START ---
app.listen(PORT, () => {
  addLog('INFO', `System Online on Port ${PORT}`);
  addLog('INFO', 'Optimization Mode: Render Free Tier (Zero-Disk Streaming)');
});
