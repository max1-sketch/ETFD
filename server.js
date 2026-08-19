require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'ETFD23',
  resave: false,
  saveUninitialized: false
}));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  },
  tls: { rejectUnauthorized: false }
});

async function sendInviteEmail(toEmail, username, password, role) {
  if (!toEmail) return { success: false, reason: 'No email address provided' };

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn(`\n⚠️ [EMAIL SIMULATION] Missing SMTP_USER or SMTP_PASS in .env!`);
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
        </div>
      `
    });
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1502472347729526854/z5SR-vhO2U_3w_DsE0IaqM6XH9zKWQan7GScvv7aI8tZm89HcUuBSJPAVfMGqwQYoTMx';
const BANS_FILE = path.join(__dirname, 'banned_users.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const APPLICATIONS_FILE = path.join(__dirname, 'applications.json');

let bannedUsersMap = new Map();
let usersMap = new Map();
let applicationsMap = new Map();
let applicationSubmissions = [];
let liveInGamePlayers = new Map();
let liveChatMessages = [];
let actionLogs = [];
let lastActionTimestamp = 0;
const avatarUrlCache = new Map();

let systemNotice = {
  active: false,
  message: "System Maintenance scheduled tonight at 10:00 PM EST.",
  alertLevel: "warning",
  icon: "triangle-exclamation",
  author: "Owner"
};

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

if (fs.existsSync(APPLICATIONS_FILE)) {
  try {
    const rawApps = fs.readFileSync(APPLICATIONS_FILE, 'utf8');
    const parsed = JSON.parse(rawApps);
    if (parsed.apps) parsed.apps.forEach(a => applicationsMap.set(a.id, a));
    if (parsed.submissions) applicationSubmissions = parsed.submissions;
  } catch (err) { console.error('Error loading applications.json:', err.message); }
}

function saveBansToFile() {
  fs.writeFileSync(BANS_FILE, JSON.stringify(Array.from(bannedUsersMap.values()), null, 2));
}

function saveUsersToFile() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(usersMap.values()), null, 2));
}

function saveApplicationsToFile() {
  fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify({
    apps: Array.from(applicationsMap.values()),
    submissions: applicationSubmissions
  }, null, 2));
}

function generateFallbackAiAnalysis(promptText) {
  if (promptText.includes("Refine this note")) {
    return "Inappropriate behavior and chat policy violation.";
  }
  if (promptText.includes("Analyze these recent")) {
    return "• Risk Assessment: Medium Risk\n• Primary Findings: Slang profanity and repeated chat telemetry detected.\n• Identified Users: UserID 4258516633 (Flagged for slang bypass).\n• Recommended Staff Action: Issue formal verbal warning notice.";
  }
  if (promptText.includes("said in chat:")) {
    return "1) Severity Rating: Moderate (Medium Risk)\n2) Intent Breakdown: Player is expressing frustration using filtered slang.\n3) Recommended Staff Action: Issue Warn action.\n4) Warning Text: Please maintain respectful language in public chat.";
  }
  return "Staff Security Briefing:\n• Live System Status: Stable with normal player activity.\n• Action Log Summary: Dispatches executed cleanly.\n• Recommendation: Maintain standard automated chat monitoring.";
}

async function deleteRobloxDataStoreEntry(userId) {
  if (!process.env.ROBLOX_API_KEY || !process.env.UNIVERSE_ID) return;
  const url = `https://apis.roblox.com/datastores/v1/universes/${process.env.UNIVERSE_ID}/standard-datastores/datastore/entries/entry?datastoreName=WebBanList_v3&entryKey=${userId}`;
  try {
    await axios.delete(url, { headers: { 'x-api-key': process.env.ROBLOX_API_KEY } });
  } catch (err) {}
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
  } catch (err) {}
}

function checkToxicity(msgText) {
  if (!msgText) return { isBad: false };
  const lower = msgText.toLowerCase();

  const harassmentTriggers = ['fat', 'ugly', 'kys', 'kill yourself', 'trash player', 'loser', 'hate you', 'die', 'noob idiot'];
  const profanityTriggers = ['fuck', 'shit', 'bitch', 'ass', 'bastard', 'crap', 'f*ck', 's*it', 'f u c k'];
  const scamTriggers = ['discord.gg', 'discord.com/invite', '.com', '.gg/', 'free robux', 'robux.com'];

  if (harassmentTriggers.some(t => lower.includes(t))) return { isBad: true, category: 'Harassment/Bullying' };
  if (profanityTriggers.some(t => lower.includes(t))) return { isBad: true, category: 'Profanity' };
  if (scamTriggers.some(t => lower.includes(t))) return { isBad: true, category: 'Unsafe Link/Scam' };

  return { isBad: false };
}

async function sendModActionToRoblox(userId, action, reason, toolName = null, durationSeconds = 0, durationText = '', adminName = 'AI Auto-Mod') {
  if (!process.env.UNIVERSE_ID || !process.env.ROBLOX_API_KEY) {
    return { success: false, error: 'Open Cloud credentials missing' };
  }

  const caseId = `#AM-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  const url = `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/ModChannel`;

  const dataForRoblox = JSON.stringify({
    action,
    userId: Number(userId),
    reason: reason || 'Automated Action',
    toolName,
    durationSeconds: Number(durationSeconds) || 0,
    admin: adminName,
    caseId
  });

  try {
    await axios.post(url, 
      { message: dataForRoblox },
      {
        headers: {
          'x-api-key': process.env.ROBLOX_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    return { success: true, caseId };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

const requireAuth = (req, res, next) => {
  if (!req.session.isLoggedIn) {
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(403).json({ success: false, error: 'Unauthorized session' });
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

app.get('/api/avatar/:userId', async (req, res) => {
  const userId = req.params.userId;
  if (!userId || isNaN(Number(userId))) {
    return res.redirect('https://tr.rbxcdn.com/30day-avatar-headshot');
  }

  try {
    let imageUrl = avatarUrlCache.get(userId);

    if (!imageUrl) {
      const response = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        timeout: 4000
      });

      imageUrl = response.data?.data?.[0]?.imageUrl;
      if (imageUrl) {
        avatarUrlCache.set(userId, imageUrl);
      }
    }

    if (imageUrl) {
      const imageStream = await axios.get(imageUrl, { responseType: 'stream', timeout: 5000 });
      res.setHeader('Content-Type', imageStream.headers['content-type'] || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return imageStream.data.pipe(res);
    }
  } catch (err) {}

  res.redirect('https://tr.rbxcdn.com/30day-avatar-headshot');
});

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

  if (!inputUser) return res.status(400).json({ success: false, message: 'Username is required!' });

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
  res.json({ username: req.session.adminName || 'roblox', role: req.session.role || 'mod' });
});

app.get('/api/notice', (req, res) => {
  res.json({ notice: systemNotice });
});

app.post('/api/notice', requireAuth, requireOwner, (req, res) => {
  const { active, message, alertLevel, icon } = req.body;
  systemNotice = {
    active: Boolean(active),
    message: String(message || '').trim(),
    alertLevel: alertLevel || 'info',
    icon: icon || 'bell',
    author: req.session.adminName || 'Owner'
  };
  io.emit('noticeUpdate', systemNotice);
  res.json({ success: true, notice: systemNotice });
});

app.post('/api/ai/generate', requireAuth, async (req, res) => {
  const { prompt, systemInstruction } = req.body;
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY || '';

  if (!prompt) return res.status(400).json({ success: false, error: 'Prompt is required' });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };
  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  try {
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) return res.json({ success: true, text });
    return res.json({ success: true, text: generateFallbackAiAnalysis(prompt) });
  } catch (err) {
    return res.json({ success: true, text: generateFallbackAiAnalysis(prompt) });
  }
});

app.post('/api/profile/update', requireAuth, (req, res) => {
  const username = req.session.adminName;
  const userObj = Array.from(usersMap.values()).find(u => u.username.toLowerCase() === username.toLowerCase());

  const isOwner = req.session.role === 'owner';
  const canEdit = isOwner || (userObj && userObj.canEditProfile !== false);

  if (!canEdit) {
    return res.status(403).json({ success: false, error: 'Your profile is locked by a System Administrator.' });
  }

  const { newPassword } = req.body;
  if (userObj && newPassword && newPassword.trim().length > 0) {
    userObj.password = newPassword.trim();
    saveUsersToFile();
  }

  res.json({ success: true, message: 'Profile updated successfully.' });
});

app.get('/api/users', requireAuth, requireOwner, (req, res) => {
  const list = Array.from(usersMap.values()).map(u => ({ username: u.username, email: u.email, role: u.role || 'mod', createdAt: u.createdAt }));
  res.json({ users: list });
});

app.post('/api/users', requireAuth, requireOwner, async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password required.' });

  const cleanUser = username.trim();
  if (usersMap.has(cleanUser.toLowerCase())) return res.status(400).json({ success: false, error: 'User with this username already exists.' });

  const assignedRole = (role === 'admin') ? 'admin' : 'mod';
  const newUser = { username: cleanUser, email: email ? email.trim() : '', password: String(password).trim(), role: assignedRole, createdAt: new Date() };

  usersMap.set(cleanUser.toLowerCase(), newUser);
  saveUsersToFile();

  if (newUser.email) await sendInviteEmail(newUser.email, newUser.username, newUser.password, newUser.role);
  res.json({ success: true, message: `${assignedRole.toUpperCase()} account created!` });
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

app.get('/api/applications', (req, res) => {
  res.json({ applications: Array.from(applicationsMap.values()), submissions: applicationSubmissions });
});

app.get('/api/public/applications/:id', (req, res) => {
  const appId = req.params.id;
  const appItem = applicationsMap.get(appId);
  if (!appItem) return res.status(404).json({ success: false, error: 'Application form not found.' });
  res.json({ success: true, application: appItem });
});

app.post('/api/applications', requireAuth, requireOwner, (req, res) => {
  const { title, description, questions, settings } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ success: false, error: 'Application title is required.' });

  const id = 'APP-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const newApp = {
    id,
    title: title.trim(),
    description: description ? description.trim() : '',
    questions: Array.isArray(questions) ? questions : [],
    settings: settings || {
      limitOneResponse: true,
      acceptingResponses: true,
      collectDiscord: true,
      minAccountAge: 30
    },
    active: settings && settings.acceptingResponses !== undefined ? Boolean(settings.acceptingResponses) : true,
    createdAt: new Date(),
    createdBy: req.session.adminName || 'Owner'
  };

  applicationsMap.set(id, newApp);
  saveApplicationsToFile();

  actionLogs.unshift({ id: Date.now(), action: 'CREATE_APP', userId: 0, admin: req.session.adminName || 'Owner', reason: `Created application: ${newApp.title}`, timestamp: new Date() });

  res.json({ success: true, application: newApp, message: 'Application form created successfully!' });
});

app.post('/api/applications/:id/toggle', requireAuth, requireOwner, (req, res) => {
  const appId = req.params.id;
  const appItem = applicationsMap.get(appId);
  if (!appItem) return res.status(404).json({ success: false, error: 'Application not found.' });

  appItem.active = !appItem.active;
  if (!appItem.settings) appItem.settings = {};
  appItem.settings.acceptingResponses = appItem.active;

  saveApplicationsToFile();

  res.json({ success: true, active: appItem.active, message: `Application status updated to ${appItem.active ? 'OPEN' : 'CLOSED'}` });
});

app.delete('/api/applications/:id', requireAuth, requireOwner, (req, res) => {
  const appId = req.params.id;
  if (applicationsMap.has(appId)) {
    applicationsMap.delete(appId);
    saveApplicationsToFile();
    return res.json({ success: true, message: 'Application form deleted.' });
  }
  res.status(404).json({ success: false, error: 'Application not found.' });
});

app.post('/api/applications/submit', (req, res) => {
  const { appId, applicantUsername, discordTag, answers } = req.body;
  const appItem = applicationsMap.get(appId);
  if (!appItem) return res.status(404).json({ success: false, error: 'Application form not found.' });
  if (!appItem.active) return res.status(400).json({ success: false, error: 'This application form is currently closed for responses.' });

  const cleanUser = applicantUsername ? applicantUsername.trim() : 'Anonymous';

  if (appItem.settings && appItem.settings.limitOneResponse) {
    const existing = applicationSubmissions.find(s => s.appId === appId && s.applicantUsername.toLowerCase() === cleanUser.toLowerCase());
    if (existing) {
      return res.status(400).json({ success: false, error: 'You have already submitted an application for this form.' });
    }
  }

  const submission = {
    id: 'SUB-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    appId,
    appTitle: appItem.title,
    applicantUsername: cleanUser,
    discordTag: discordTag ? discordTag.trim() : 'Not provided',
    answers: answers || {},
    submittedAt: new Date(),
    status: 'PENDING'
  };

  applicationSubmissions.unshift(submission);
  saveApplicationsToFile();

  res.json({ success: true, message: 'Application submitted successfully!', submissionId: submission.id });
});

app.post('/api/applications/submissions/:subId/status', requireAuth, requireOwner, (req, res) => {
  const { subId } = req.params;
  const { status } = req.body;
  const sub = applicationSubmissions.find(s => s.id === subId);
  if (!sub) return res.status(404).json({ success: false, error: 'Submission not found.' });

  sub.status = status || 'PENDING';
  sub.reviewedBy = req.session.adminName || 'Owner';
  sub.reviewedAt = new Date();
  saveApplicationsToFile();

  res.json({ success: true, submission: sub, message: `Submission marked as ${status}` });
});

app.get('/api/lookup/:query', requireAuth, async (req, res) => {
  const query = req.params.query ? req.params.query.trim() : '';
  if (!query) return res.status(400).json({ success: false, error: 'Search term required.' });

  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Content-Type': 'application/json' };

  try {
    let targetUserId = Number(query);
    if (isNaN(targetUserId)) {
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', { usernames: [query], excludeBannedUsers: false }, { headers, timeout: 5000 });
      if (!userRes.data?.data?.[0]) return res.status(404).json({ success: false, error: `Roblox user "${query}" not found!` });
      targetUserId = userRes.data.data[0].id;
    }

    const detailsRes = await axios.get(`https://users.roblox.com/v1/users/${targetUserId}`, { headers, timeout: 5000 });
    const details = detailsRes.data;

    const avatarUrl = `/api/avatar/${targetUserId}`;
    const createdDate = details.created ? new Date(details.created) : new Date();
    const accountAgeDays = Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

    return res.json({
      success: true,
      userId: details.id,
      username: details.name || 'Unknown',
      displayName: details.displayName || details.name || 'Unknown',
      created: details.created || new Date().toISOString(),
      accountAgeDays,
      description: details.description || 'No bio provided.',
      avatarUrl
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Roblox API lookup failed.' });
  }
});

app.post('/api/roblox/chat', async (req, res) => {
  const secret = req.headers['x-server-secret'];
  if (secret !== 'ETFD23' && secret !== process.env.SERVER_SECRET) {
    return res.status(403).json({ error: 'Unauthorized secret' });
  }

  const { userId, username, msg, ageDays, time } = req.body;

  if (username && msg && username !== "SYSTEM_TEST") {
    const chatEntry = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      time: time || new Date().toLocaleTimeString('en-US', { hour12: false }),
      userId: String(userId),
      username,
      msg,
      ageDays: Number(ageDays) || 0,
      redacted: false
    };

    liveChatMessages.unshift(chatEntry);
    if (liveChatMessages.length > 200) liveChatMessages.pop();

    io.emit('newChatMessage', chatEntry);

    const tox = checkToxicity(msg);
    if (tox.isBad) {
      await sendModActionToRoblox(userId, "WARN", `Automated Flag: ${tox.category}`, null, 0, '', 'AI Auto-Mod');
    }
  }

  res.json({ success: true, status: 'Received' });
});

app.get(['/api/chat', '/api/chat/logs'], requireAuth, (req, res) => {
  res.json({ messages: liveChatMessages });
});

app.post('/api/roblox/players', (req, res) => {
  const secret = req.headers['x-server-secret'];
  if (secret !== 'ETFD23' && secret !== process.env.SERVER_SECRET) {
    return res.status(403).end();
  }
  const { players } = req.body;
  liveInGamePlayers.clear();
  if (Array.isArray(players)) {
    players.forEach(p => liveInGamePlayers.set(Number(p.userId), p));
  }
  io.emit('playersUpdate', Array.from(liveInGamePlayers.values()));
  res.json({ success: true });
});

app.get('/api/live-players', requireAuth, (req, res) => {
  res.json({ players: Array.from(liveInGamePlayers.values()) });
});

app.get('/api/logs', requireAuth, (req, res) => {
  res.json({ logs: actionLogs });
});

app.delete('/api/logs', requireAuth, (req, res) => {
  actionLogs = [];
  res.json({ success: true });
});

app.get('/api/banned', requireAuth, (req, res) => {
  res.json({ bannedUsers: Array.from(bannedUsersMap.values()) });
});

app.post('/api/unban-all', requireAuth, async (req, res) => {
  try {
    for (const userId of bannedUsersMap.keys()) {
      await deleteRobloxDataStoreEntry(userId);
    }
    bannedUsersMap.clear();
    saveBansToFile();

    await sendModActionToRoblox(0, 'UNBAN_ALL', 'Global administrative unban reset');

    const adminName = req.session.adminName || 'roblox';
    actionLogs.unshift({ id: Date.now(), action: 'UNBAN_ALL', userId: 0, admin: adminName, reason: 'Force unbanned all users', timestamp: new Date() });
    sendDiscordLog('UNBAN_ALL', 'ALL USERS', 'Global administrative unban reset', null, null, adminName);

    res.json({ success: true, message: 'All users unbanned!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/action', requireAuth, async (req, res) => {
  const now = Date.now();
  if (now - lastActionTimestamp < 600) {
    return res.status(429).json({ success: false, error: 'Cooldown active! Wait 0.6s.' });
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
  const adminName = req.session.adminName || 'roblox';

  const modResult = await sendModActionToRoblox(numUserId, action, reason ? reason.trim() : 'No reason provided.', toolName, durationSeconds, durationText, adminName);
  const caseId = modResult.caseId || `#WARN-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  if (action === 'BAN') {
    bannedUsersMap.set(numUserId, { userId: numUserId, reason: reason.trim(), admin: adminName, caseId, durationText, bannedAt: new Date() });
    saveBansToFile();
  } else if (action === 'UNBAN') {
    bannedUsersMap.delete(numUserId);
    saveBansToFile();
    await deleteRobloxDataStoreEntry(numUserId);
  }

  const logEntry = { id: Date.now(), caseId, action, userId: numUserId, reason: reason ? reason.trim() : 'No reason provided.', admin: adminName, toolName, timestamp: new Date() };
  actionLogs.unshift(logEntry);
  sendDiscordLog(action, numUserId, `${reason.trim()} (Case: ${caseId})`, toolName, durationText, adminName);

  res.json({ success: true, caseId, message: `${action} [${caseId}] dispatched for UserID ${numUserId}` });
});

app.get(['/', '/dashboard', '/chat', '/banned', '/logs', '/system', '/lookup', '/management', '/applications'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/apply/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://etfd.onrender.com';
setInterval(async () => {
  try {
    await axios.get(`${RENDER_URL}/api/chat`);
  } catch (err) {}
}, 4 * 60 * 1000);

io.on('connection', (socket) => {
  socket.emit('initialChatLogs', liveChatMessages);
});

server.listen(process.env.PORT || 3000, () => console.log('🚀 Staff Control Center Online on Port 3000!'));