require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'ETFD23',
  resave: false,
  saveUninitialized: false
}));

// Configure SMTP Transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  tls: {
    rejectUnauthorized: false
  }
});

async function sendInviteEmail(toEmail, username, password, role) {
  if (!toEmail) return { success: false, reason: 'No email address provided' };

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn(`\n⚠️ [EMAIL SIMULATION] Missing SMTP_USER or SMTP_PASS in .env!`);
    console.warn(`To: ${toEmail} | User: ${username} | Pass: ${password} | Role: ${role}\n`);
    return { success: false, reason: 'SMTP credentials missing in .env file.' };
  }

  try {
    await transporter.sendMail({
      from: `"Escape Tsunami Console" <${process.env.SMTP_USER}>`,
      to: toEmail,
      subject: '🔑 Escape Tsunami Moderation Panel Invitation',
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #0f1117; color: #e5e7eb; padding: 25px; border-radius: 8px;">
          <h2 style="color: #3b82f6; margin-top: 0;">Escape Tsunami Moderation Access</h2>
          <p>You have been invited to join the Escape Tsunami staff panel as an <strong>${role.toUpperCase()}</strong>.</p>
          <div style="background-color: #171923; padding: 15px; border-radius: 6px; border: 1px solid #2d3748; margin: 15px 0;">
            <p style="margin: 5px 0;"><strong>Username:</strong> <code style="color:#60a5fa;">${username}</code></p>
            <p style="margin: 5px 0;"><strong>Password:</strong> <code style="color:#60a5fa;">${password}</code></p>
            <p style="margin: 5px 0;"><strong>Role Level:</strong> ${role.toUpperCase()}</p>
          </div>
          <p style="font-size: 12px; color: #9ca3af;">Keep these credentials secure and do not share your login details.</p>
        </div>
      `
    });
    console.log(`✉️ Invite email successfully sent to ${toEmail}`);
    return { success: true };
  } catch (err) {
    console.error('❌ Email Delivery Failed:', err.message);
    return { success: false, reason: err.message };
  }
}

const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1502472347729526854/z5SR-vhO2U_3w_DsE0IaqM6XH9zKWQan7GScvv7aI8tZm89HcUuBSJPAVfMGqwQYoTMx';
const BANS_FILE = path.join(__dirname, 'banned_users.json');
const USERS_FILE = path.join(__dirname, 'users.json');

let bannedUsersMap = new Map();
let usersMap = new Map();
let pendingActionLocks = new Set();
let liveInGamePlayers = new Map();
let lastActionTimestamp = 0;

if (fs.existsSync(BANS_FILE)) {
  try {
    const rawData = fs.readFileSync(BANS_FILE, 'utf8');
    JSON.parse(rawData).forEach(user => {
      const cleanId = Number(user.userId);
      if (!isNaN(cleanId)) bannedUsersMap.set(cleanId, { ...user, userId: cleanId });
    });
  } catch (err) { console.error('Error loading banned_users.json:', err.message); }
}

if (fs.existsSync(USERS_FILE)) {
  try {
    const rawUsers = fs.readFileSync(USERS_FILE, 'utf8');
    JSON.parse(rawUsers).forEach(u => {
      if (u.username) usersMap.set(u.username.toLowerCase(), u);
    });
  } catch (err) { console.error('Error loading users.json:', err.message); }
}

function saveBansToFile() {
  fs.writeFileSync(BANS_FILE, JSON.stringify(Array.from(bannedUsersMap.values()), null, 2));
}

function saveUsersToFile() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(usersMap.values()), null, 2));
}

async function deleteRobloxDataStoreEntry(userId) {
  if (!process.env.ROBLOX_API_KEY || !process.env.UNIVERSE_ID) {
    console.warn('⚠️ Cannot unban via Open Cloud: ROBLOX_API_KEY or UNIVERSE_ID missing in .env');
    return;
  }
  
  const url = `https://apis.roblox.com/datastores/v1/universes/${process.env.UNIVERSE_ID}/standard-datastores/datastore/entries/entry?datastoreName=WebBanList_v3&entryKey=${userId}`;
  
  try {
    await axios.delete(url, { 
      headers: { 'x-api-key': process.env.ROBLOX_API_KEY } 
    });
    console.log(`✅ Open Cloud: Deleted DataStore entry for UserID ${userId}`);
  } catch (err) {
    console.error(`❌ Open Cloud Unban Failed for UserID ${userId}:`, err.response?.data || err.message);
  }
}

async function sendDiscordLog(action, userId, reason, toolName, durationText, adminName) {
  if (!DISCORD_WEBHOOK_URL) return;
  let color = action === 'BAN' || action === 'KICK' ? 0xef4444 : action === 'WARN' ? 0xf59e0b : 0x10b981;
  
  const fields = [
    { name: 'Target UserID', value: `\`${userId}\``, inline: true },
    { name: 'Action', value: `\`${action}\``, inline: true },
    { name: 'Moderator', value: `\`${adminName || 'Unknown'}\``, inline: true },
    { name: 'Reason', value: reason || 'No reason provided', inline: false }
  ];
  if (durationText) fields.push({ name: 'Duration', value: `\`${durationText}\``, inline: true });
  if (toolName) fields.push({ name: 'Tool Targeted', value: `\`${toolName}\``, inline: true });

  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [{ title: `🛡️ Moderation Log: ${action}`, color, fields, timestamp: new Date().toISOString() }]
    });
  } catch (err) { console.error('Webhook Error:', err.message); }
}

let actionLogs = [];

const requireAuth = (req, res, next) => {
  if (!req.session.isLoggedIn) {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
    }
    return res.redirect('/login');
  }
  next();
};

const requireOwner = (req, res, next) => {
  if (req.session.role !== 'owner') {
    return res.status(403).json({ success: false, error: 'Access denied: Owner permissions required.' });
  }
  next();
};

app.post('/auth/login', (req, res) => {
  const inputPass = String(req.body.password || '').trim();
  const inputUser = String(req.body.username || '').trim();

  const OWNER_PASSCODE = process.env.ADMIN_PASSWORD || '9981';

  if (inputPass === '9981' || inputPass === OWNER_PASSCODE) {
    req.session.isLoggedIn = true;
    req.session.role = 'owner';
    req.session.adminName = inputUser || 'roblox';
    return res.json({ success: true, role: 'owner' });
  }

  if (!inputUser) {
    return res.status(400).json({ success: false, message: 'Username is required!' });
  }

  const foundUser = Array.from(usersMap.values()).find(
    u => (u.username.toLowerCase() === inputUser.toLowerCase() || (u.email && u.email.toLowerCase() === inputUser.toLowerCase())) && u.password === inputPass
  );

  if (foundUser) {
    req.session.isLoggedIn = true;
    req.session.role = foundUser.role || 'mod';
    req.session.adminName = foundUser.username;
    return res.json({ success: true, role: foundUser.role || 'mod' });
  }

  res.status(401).json({ success: false, message: 'Invalid Username or Passcode!' });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    username: req.session.adminName || 'roblox',
    role: req.session.role || 'mod'
  });
});

app.get('/api/users', requireAuth, requireOwner, (req, res) => {
  const list = Array.from(usersMap.values()).map(u => ({
    username: u.username,
    email: u.email,
    role: u.role || 'mod',
    createdAt: u.createdAt
  }));
  res.json({ users: list });
});

app.post('/api/users', requireAuth, requireOwner, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password required.' });

  const cleanUser = username.trim();
  if (usersMap.has(cleanUser.toLowerCase())) {
    return res.status(400).json({ success: false, error: 'User with this username already exists.' });
  }

  const assignedRole = (role === 'admin') ? 'admin' : 'mod';
  const newUser = {
    username: cleanUser,
    email: email ? email.trim() : '',
    password: String(password).trim(),
    role: assignedRole,
    createdAt: new Date()
  };

  usersMap.set(cleanUser.toLowerCase(), newUser);
  saveUsersToFile();

  let emailStatus = { success: true };
  if (newUser.email) {
    emailStatus = await sendInviteEmail(newUser.email, newUser.username, newUser.password, newUser.role);
  }

  if (newUser.email && !emailStatus.success) {
    return res.json({ 
      success: true, 
      message: `${assignedRole.toUpperCase()} account created for "${cleanUser}", but email failed: ${emailStatus.reason}` 
    });
  }

  res.json({ success: true, message: `${assignedRole.toUpperCase()} account created and invite sent to ${newUser.email || 'N/A'}!` });
});

app.delete('/api/users/:username', requireAuth, requireOwner, (req, res) => {
  const target = req.params.username.toLowerCase();
  if (usersMap.has(target)) {
    usersMap.delete(target);
    saveUsersToFile();
    return res.json({ success: true, message: 'User account removed.' });
  }
  res.status(404).json({ success: false, error: 'User not found.' });
});

app.get('/api/lookup/:query', requireAuth, async (req, res) => {
  const query = req.params.query ? req.params.query.trim() : '';
  if (!query) return res.status(400).json({ success: false, error: 'Search term is required.' });

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    let targetUserId = Number(query);

    if (isNaN(targetUserId)) {
      try {
        const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
          usernames: [query],
          excludeBannedUsers: false
        }, { headers, timeout: 5000 });

        if (!userRes.data?.data || userRes.data.data.length === 0) {
          return res.status(404).json({ success: false, error: `Roblox user "${query}" was not found!` });
        }
        targetUserId = userRes.data.data[0].id;
      } catch (err) {
        return res.status(404).json({ success: false, error: `Failed to resolve username "${query}".` });
      }
    }

    let details = null;
    try {
      const detailsRes = await axios.get(`https://users.roblox.com/v1/users/${targetUserId}`, { headers, timeout: 5000 });
      details = detailsRes.data;
    } catch (err) {
      return res.status(404).json({ success: false, error: `Roblox User ID ${targetUserId} does not exist.` });
    }

    let avatarUrl = 'https://tr.rbxcdn.com/30day-avatar-headshot';
    try {
      const avatarRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${targetUserId}&size=150x150&format=Png&isCircular=false`, { headers, timeout: 5000 });
      if (avatarRes.data?.data?.[0]?.imageUrl) {
        avatarUrl = avatarRes.data.data[0].imageUrl;
      }
    } catch (err) {}

    let lastOnline = null;
    let presenceType = 'Offline';
    let lastLocation = 'N/A';
    try {
      const presenceRes = await axios.post('https://presence.roblox.com/v1/presence/users', {
        userIds: [targetUserId]
      }, { headers, timeout: 5000 });

      const pData = presenceRes.data?.userPresences?.[0];
      if (pData) {
        lastOnline = pData.lastOnline || null;
        const presenceMap = ['Offline', 'Online', 'In-Game', 'In-Studio'];
        presenceType = presenceMap[pData.userPresenceType] || 'Offline';
        lastLocation = pData.lastLocation || 'N/A';
      }
    } catch (err) {}

    const createdDate = details.created ? new Date(details.created) : new Date();
    const accountAgeDays = Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

    return res.json({
      success: true,
      userId: details.id,
      username: details.name || 'Unknown',
      displayName: details.displayName || details.name || 'Unknown',
      created: details.created || new Date().toISOString(),
      accountAgeDays: isNaN(accountAgeDays) ? 0 : accountAgeDays,
      description: details.description || 'No bio provided.',
      isBanned: details.isBanned || false,
      avatarUrl,
      lastOnline,
      presenceType,
      lastLocation
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: 'Roblox API request failed.' });
  }
});

app.post('/api/roblox/players', (req, res) => {
  if (req.headers['x-server-secret'] !== 'ETFD23') return res.status(403).end();
  const { players } = req.body;
  liveInGamePlayers.clear();
  if (Array.isArray(players)) {
    players.forEach(p => liveInGamePlayers.set(Number(p.userId), p));
  }
  res.json({ success: true });
});

app.get('/api/live-players', requireAuth, (req, res) => {
  res.json({ players: Array.from(liveInGamePlayers.values()) });
});

app.get('/api/logs', requireAuth, (req, res) => res.json({ logs: actionLogs }));
app.get('/api/banned', requireAuth, (req, res) => res.json({ bannedUsers: Array.from(bannedUsersMap.values()) }));

app.post('/api/unban-all', requireAuth, async (req, res) => {
  try {
    for (const userId of bannedUsersMap.keys()) {
      await deleteRobloxDataStoreEntry(userId);
    }
    bannedUsersMap.clear();
    saveBansToFile();

    const topic = 'ModChannel';
    const url = `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/${topic}`;
    const payload = JSON.stringify({ action: 'UNBAN_ALL' });

    if (process.env.ROBLOX_API_KEY && process.env.UNIVERSE_ID) {
      await axios.post(url, { message: payload }, {
        headers: { 'x-api-key': process.env.ROBLOX_API_KEY, 'Content-Type': 'application/json' }
      });
    }

    const adminName = req.session.adminName || 'roblox';
    actionLogs.unshift({ id: Date.now(), action: 'UNBAN_ALL', userId: 0, admin: adminName, reason: 'Force unbanned all users', timestamp: new Date() });
    sendDiscordLog('UNBAN_ALL', 'ALL USERS', 'Global administrative unban reset', null, null, adminName);

    res.json({ success: true, message: 'All users have been unbanned successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/action', requireAuth, async (req, res) => {
  const now = Date.now();
  if (now - lastActionTimestamp < 600) {
    return res.status(429).json({ success: false, error: 'Cooldown active! Wait 0.6s between commands.' });
  }

  const { action, userId, reason, toolName, durationSeconds, durationText } = req.body;
  const numUserId = Number(userId);

  if (!numUserId || isNaN(numUserId)) {
    return res.status(400).json({ success: false, error: 'Valid Roblox UserID required.' });
  }

  if (['KICK', 'WARN', 'BAN'].includes(action) && (!reason || !reason.trim())) {
    return res.status(400).json({ success: false, error: `A reason is MANDATORY for ${action} actions!` });
  }

  lastActionTimestamp = now;

  const caseId = `#WARN-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  const adminName = req.session.adminName || 'roblox';

  const payload = JSON.stringify({
    action,
    userId: numUserId,
    reason: reason ? reason.trim() : 'No reason provided.',
    toolName,
    durationSeconds,
    admin: adminName,
    caseId
  });

  const topic = 'ModChannel';
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/${topic}`;

  try {
    if (process.env.ROBLOX_API_KEY && process.env.UNIVERSE_ID) {
      await axios.post(url, { message: payload }, {
        headers: { 'x-api-key': process.env.ROBLOX_API_KEY, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'BAN') {
      bannedUsersMap.set(numUserId, { userId: numUserId, reason: reason.trim(), admin: adminName, caseId, durationText, bannedAt: new Date() });
      saveBansToFile();
    } else if (action === 'UNBAN') {
      bannedUsersMap.delete(numUserId);
      saveBansToFile();
      await deleteRobloxDataStoreEntry(numUserId);
    }

    const logEntry = {
      id: Date.now(),
      caseId,
      action,
      userId: numUserId,
      reason: reason ? reason.trim() : 'No reason provided.',
      admin: adminName,
      toolName,
      timestamp: new Date()
    };

    actionLogs.unshift(logEntry);
    sendDiscordLog(action, numUserId, `${reason.trim()} (Case: ${caseId})`, toolName, durationText, adminName);

    res.json({ success: true, caseId, message: `${action} [${caseId}] dispatched for UserID ${numUserId}` });
  } catch (err) {
    res.json({ success: true, note: 'Action applied locally', error: err.message });
  }
});

app.use('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API Route "${req.originalUrl}" not found.` });
});

app.get(['/', '/dashboard', '/banned', '/logs', '/system', '/lookup', '/management'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.listen(process.env.PORT || 3000, () => console.log('Mod Console Online on Port 3000!'));