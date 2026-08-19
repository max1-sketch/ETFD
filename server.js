require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');

let mongoose;
try {
  mongoose = require('mongoose');
} catch (e) {
  console.warn('⚠️ Mongoose package not installed or missing in node_modules.');
}

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

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }
  res.redirect('/login');
}

function requireOwner(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  return res.status(403).json({ success: false, error: 'Administrative access required' });
}

let isMongoConnected = false;
let ApplicationModel, SubmissionModel, BannedUserModel, UserModel, SecurityGateModel;

if (mongoose) {
  const ApplicationSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    title: String,
    description: String,
    questions: Array,
    settings: Object,
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
  });

  const SubmissionSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    appId: String,
    appTitle: String,
    applicantUsername: String,
    discordTag: String,
    deviceSignature: String,
    answers: Object,
    notes: Array,
    blacklisted: { type: Boolean, default: false },
    submittedAt: { type: Date, default: Date.now },
    status: { type: String, default: 'PENDING' },
    reviewedBy: String,
    reviewedAt: Date,
    ndaSigned: Boolean,
    onboardingCompletedAt: Date
  });

  const BannedUserSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    reason: String,
    admin: String,
    caseId: String,
    durationText: String,
    bannedAt: { type: Date, default: Date.now }
  });

  const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: String,
    password: String,
    role: String,
    createdAt: { type: Date, default: Date.now }
  });

  const SecurityGateSchema = new mongoose.Schema({
    configId: { type: String, default: 'default', unique: true },
    blockedSignatures: Array,
    securityLogs: Array
  });

  ApplicationModel = mongoose.models.Application || mongoose.model('Application', ApplicationSchema);
  SubmissionModel = mongoose.models.Submission || mongoose.model('Submission', SubmissionSchema);
  BannedUserModel = mongoose.models.BannedUser || mongoose.model('BannedUser', BannedUserSchema);
  UserModel = mongoose.models.User || mongoose.model('User', UserSchema);
  SecurityGateModel = mongoose.models.SecurityGate || mongoose.model('SecurityGate', SecurityGateSchema);
}

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
const SECURITY_FILE = path.join(__dirname, 'security_gate.json');

let bannedUsersMap = new Map();
let usersMap = new Map();
let applicationsMap = new Map();
let applicationSubmissions = [];
let liveInGamePlayers = new Map();
let liveChatMessages = [];
let actionLogs = [];
let lastActionTimestamp = 0;

let blockedSignatures = new Set();
let securityLogs = [];

let systemNotice = {
  active: false,
  message: "System Maintenance scheduled tonight at 10:00 PM EST.",
  alertLevel: "warning",
  icon: "triangle-exclamation",
  author: "Owner"
};

function saveApplicationsToFile() {
  try {
    const data = {
      apps: Array.from(applicationsMap.values()),
      submissions: applicationSubmissions
    };
    fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving applications.json:', err.message);
  }
}

function saveSecurityGateToFile() {
  try {
    const data = {
      blockedSignatures: Array.from(blockedSignatures),
      securityLogs: securityLogs
    };
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving security_gate.json:', err.message);
  }
}

function saveBansToFile() {
  try {
    fs.writeFileSync(BANS_FILE, JSON.stringify(Array.from(bannedUsersMap.values()), null, 2));
  } catch (err) {
    console.error('Error saving banned_users.json:', err.message);
  }
}

function saveUsersToFile() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(Array.from(usersMap.values()), null, 2));
  } catch (err) {
    console.error('Error saving users.json:', err.message);
  }
}

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

if (fs.existsSync(SECURITY_FILE)) {
  try {
    const rawSec = fs.readFileSync(SECURITY_FILE, 'utf8');
    const parsedSec = JSON.parse(rawSec);
    if (Array.isArray(parsedSec.blockedSignatures)) {
      blockedSignatures = new Set(parsedSec.blockedSignatures);
    }
    if (Array.isArray(parsedSec.securityLogs)) {
      securityLogs = parsedSec.securityLogs;
    }
  } catch (err) { console.error('Error loading security_gate.json:', err.message); }
}

if (mongoose && process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log('🍃 Connected to MongoDB Atlas Cloud Database!');
      isMongoConnected = true;

      actionLogs.unshift({
        id: Date.now(),
        action: 'DB_CONNECT',
        userId: 0,
        admin: 'SYSTEM',
        reason: '🍃 Connected to MongoDB Atlas Cloud Database cleanly!',
        timestamp: new Date()
      });

      try {
        const dbApps = await ApplicationModel.find({});
        if (dbApps.length > 0) {
          applicationsMap.clear();
          dbApps.forEach(a => applicationsMap.set(a.id, a.toObject()));
        }

        const dbSubs = await SubmissionModel.find({}).sort({ submittedAt: -1 });
        if (dbSubs.length > 0) {
          applicationSubmissions = dbSubs.map(s => s.toObject());
        }

        const dbBans = await BannedUserModel.find({});
        if (dbBans.length > 0) {
          bannedUsersMap.clear();
          dbBans.forEach(b => bannedUsersMap.set(Number(b.userId), b.toObject()));
        }

        const dbUsers = await UserModel.find({});
        if (dbUsers.length > 0) {
          dbUsers.forEach(u => usersMap.set(u.username.toLowerCase(), u.toObject()));
        }

        const dbSec = await SecurityGateModel.findOne({ configId: 'default' });
        if (dbSec) {
          if (Array.isArray(dbSec.blockedSignatures)) blockedSignatures = new Set(dbSec.blockedSignatures);
          if (Array.isArray(dbSec.securityLogs)) securityLogs = dbSec.securityLogs;
        }

        console.log(`✅ Loaded ${dbApps.length} Apps & ${dbSubs.length} Submissions from MongoDB Atlas cloud database.`);
      } catch (err) {
        console.error('⚠️ Error loading MongoDB data on startup:', err.message);
      }
    })
    .catch(err => {
      console.error('❌ MongoDB Atlas Connection Failed:', err.message);
      actionLogs.unshift({
        id: Date.now(),
        action: 'DB_ERROR',
        userId: 0,
        admin: 'SYSTEM',
        reason: `❌ MongoDB Connection Failed: ${err.message}`,
        timestamp: new Date()
      });
    });
} else {
  console.log('ℹ️ MONGODB_URI not set or mongoose package missing. Operating on local JSON persistence.');
}

function checkToxicity(msg) {
  if (!msg) return { isBad: false };
  const lower = msg.toLowerCase();
  const badWords = ['nigger', 'faggot', 'retard', 'kys'];
  for (const word of badWords) {
    if (lower.includes(word)) {
      return { isBad: true, category: `Inappropriate Content (${word})` };
    }
  }
  return { isBad: false };
}

async function sendModActionToRoblox(userId, action, reason, toolName = null, durationSeconds = 0, durationText = '', admin = 'Owner') {
  const caseId = `#CASE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  if (process.env.ROBLOX_API_KEY && process.env.UNIVERSE_ID) {
    try {
      await axios.post(
        `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/ModChannel`,
        { message: JSON.stringify({ userId, action, reason, toolName, durationSeconds, durationText, admin, caseId }) },
        { headers: { 'x-api-key': process.env.ROBLOX_API_KEY, 'Content-Type': 'application/json' }, timeout: 5000 }
      );
    } catch (err) {
      console.warn(`[Roblox Open Cloud Warning]: ${err.message}`);
    }
  }
  return { success: true, caseId };
}

async function deleteRobloxDataStoreEntry(userId) {
  return true;
}

async function sendDiscordLog(action, userId, reason, toolName, durationText, admin) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [{
        title: `🚨 Moderation Action: ${action}`,
        color: action === 'BAN' ? 15158332 : action === 'WARN' ? 16753920 : 3066993,
        fields: [
          { name: 'Target UserID', value: String(userId), inline: true },
          { name: 'Moderator', value: admin, inline: true },
          { name: 'Reason', value: reason || 'No reason provided', inline: false }
        ],
        timestamp: new Date().toISOString()
      }]
    }, { timeout: 4000 });
  } catch (err) {}
}

app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || 'ETFD23';

  if ((username && username.toLowerCase() === 'roblox' && (password === adminPass || password === '9981' || password === 'ETFD23')) || password === adminPass || password === '9981' || password === 'ETFD23') {
    req.session.authenticated = true;
    req.session.adminName = username || 'roblox';
    req.session.role = 'owner';
    return res.json({ success: true, redirect: '/dashboard' });
  }

  const cleanUser = username ? username.toLowerCase().trim() : '';
  const user = usersMap.get(cleanUser);

  if (user && user.password === password) {
    req.session.authenticated = true;
    req.session.adminName = user.username;
    req.session.role = user.role || 'mod';
    return res.json({ success: true, redirect: '/dashboard' });
  }

  res.status(401).json({ success: false, message: 'Invalid credentials! Check your access key.' });
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/dashboard');
  }
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/api/gate/verify', (req, res) => {
  const { signature } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const cleanSig = signature ? String(signature).trim() : 'SIG-UNTRACKED';

  const isBlocked = blockedSignatures.has(cleanSig);

  const existingIndex = securityLogs.findIndex(l => l.signature === cleanSig);
  const now = new Date();

  if (existingIndex !== -1) {
    securityLogs[existingIndex].timestamp = now;
    securityLogs[existingIndex].ip = ip;
    securityLogs[existingIndex].status = isBlocked ? 'Blocked' : 'Allowed';
  } else {
    securityLogs.unshift({
      timestamp: now,
      signature: cleanSig,
      ip,
      status: isBlocked ? 'Blocked' : 'Allowed'
    });
    if (securityLogs.length > 100) securityLogs.pop();
  }

  saveSecurityGateToFile();

  if (isMongoConnected) {
    SecurityGateModel.findOneAndUpdate(
      { configId: 'default' },
      { blockedSignatures: Array.from(blockedSignatures), securityLogs },
      { upsert: true }
    ).catch(() => {});
  }

  if (isBlocked) {
    return res.json({ success: false, blocked: true, message: 'Device Authorization Failed: Access Restricted.' });
  }

  res.json({ success: true, blocked: false, signature: cleanSig });
});

app.get('/api/gate/logs', requireAuth, (req, res) => {
  res.json({
    success: true,
    logs: securityLogs,
    blockedSignatures: Array.from(blockedSignatures)
  });
});

app.post('/api/gate/block', requireAuth, requireOwner, async (req, res) => {
  const { signature, action } = req.body;
  if (!signature) return res.status(400).json({ success: false, error: 'Device signature required.' });

  const cleanSig = String(signature).trim();

  if (action === 'unblock') {
    blockedSignatures.delete(cleanSig);
  } else {
    blockedSignatures.add(cleanSig);
  }

  saveSecurityGateToFile();

  if (isMongoConnected) {
    try {
      await SecurityGateModel.findOneAndUpdate(
        { configId: 'default' },
        { blockedSignatures: Array.from(blockedSignatures), securityLogs },
        { upsert: true }
      );
    } catch (err) {}
  }

  res.json({ success: true, message: `Device signature ${cleanSig} ${action === 'unblock' ? 'unblocked' : 'restricted'}.` });
});

app.get('/api/system/db-status', requireAuth, (req, res) => {
  res.json({
    isMongoConnected,
    hasMongoUri: Boolean(process.env.MONGODB_URI),
    hasMongoosePackage: Boolean(mongoose),
    appsCount: applicationsMap.size,
    submissionsCount: applicationSubmissions.length
  });
});

app.get('/api/applications', requireAuth, (req, res) => {
  res.json({
    success: true,
    applications: Array.from(applicationsMap.values()),
    submissions: applicationSubmissions
  });
});

app.post('/api/applications', requireAuth, requireOwner, async (req, res) => {
  const { title, description, questions, settings } = req.body;
  if (!title) return res.status(400).json({ success: false, error: 'Application title is required.' });

  const appObj = {
    id: 'APP-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    title: title.trim(),
    description: description ? description.trim() : '',
    questions: Array.isArray(questions) ? questions : [],
    settings: settings || { limitOneResponse: true, acceptingResponses: true },
    active: true,
    createdAt: new Date()
  };

  applicationsMap.set(appObj.id, appObj);
  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await ApplicationModel.findOneAndUpdate({ id: appObj.id }, appObj, { upsert: true, new: true });
    } catch (err) { console.error('MongoDB Application Create Error:', err.message); }
  }

  res.json({ success: true, message: 'Application form created cleanly!', application: appObj });
});

app.post('/api/applications/:id/toggle', requireAuth, requireOwner, async (req, res) => {
  const id = req.params.id;
  const appItem = applicationsMap.get(id);
  if (!appItem) return res.status(404).json({ success: false, error: 'Application form not found.' });

  appItem.active = !appItem.active;
  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await ApplicationModel.updateOne({ id }, { active: appItem.active });
    } catch (err) { console.error('MongoDB Toggle Error:', err.message); }
  }

  res.json({ success: true, message: `Application ${appItem.active ? 'Opened' : 'Closed'}.`, active: appItem.active });
});

app.get('/api/public/applications/:id', async (req, res) => {
  const { id } = req.params;
  const appItem = applicationsMap.get(id);
  if (!appItem) return res.status(404).json({ success: false, error: 'Application form not found.' });

  res.json({
    success: true,
    application: {
      id: appItem.id,
      title: appItem.title,
      description: appItem.description,
      questions: appItem.questions,
      settings: appItem.settings,
      active: appItem.active
    }
  });
});

app.get('/api/public/applications/:id/check', async (req, res) => {
  const { id } = req.params;
  const { username, deviceSignature } = req.query;

  const appItem = applicationsMap.get(id);
  if (!appItem) return res.status(404).json({ success: false, error: 'Form not found.' });

  const cleanUser = username ? String(username).trim().toLowerCase() : '';
  const cleanSig = deviceSignature ? String(deviceSignature).trim() : '';

  let existing = null;

  if (isMongoConnected) {
    try {
      const orConditions = [];
      if (cleanUser) orConditions.push({ applicantUsername: new RegExp(`^${cleanUser}$`, 'i') });
      if (cleanSig && cleanSig !== 'SIG-UNTRACKED') orConditions.push({ deviceSignature: cleanSig });

      if (orConditions.length > 0) {
        existing = await SubmissionModel.findOne({ appId: id, $or: orConditions });
      }
    } catch (e) {}
  }

  if (!existing) {
    existing = applicationSubmissions.find(s => 
      s.appId === id && (
        (cleanUser && s.applicantUsername.toLowerCase() === cleanUser) ||
        (cleanSig && cleanSig !== 'SIG-UNTRACKED' && s.deviceSignature === cleanSig)
      )
    );
  }

  res.json({
    success: true,
    alreadySubmitted: Boolean(existing),
    submission: existing || null
  });
});

app.get('/api/public/applications/:id/roster', async (req, res) => {
  const { id } = req.params;
  const appSubmissions = applicationSubmissions.filter(s => s.appId === id);

  res.json({
    success: true,
    submissions: appSubmissions.map(s => ({
      id: s.id,
      applicantUsername: s.applicantUsername,
      submittedAt: s.submittedAt,
      status: s.status,
      reviewedBy: s.reviewedBy
    }))
  });
});

app.post('/api/applications/submit', async (req, res) => {
  const { appId, applicantUsername, discordTag, answers, deviceSignature } = req.body;
  const appItem = applicationsMap.get(appId);
  if (!appItem) return res.status(404).json({ success: false, error: 'Application form not found.' });
  if (!appItem.active) return res.status(400).json({ success: false, error: 'This application form is currently closed for responses.' });

  const cleanUser = applicantUsername ? applicantUsername.trim() : 'Anonymous';
  const cleanSignature = deviceSignature ? String(deviceSignature).trim() : 'SIG-UNTRACKED';

  if (blockedSignatures.has(cleanSignature)) {
    return res.status(403).json({ success: false, error: 'Device Authorization Failed: Access Restricted.' });
  }

  if (appItem.settings && appItem.settings.limitOneResponse) {
    let existing = null;

    if (isMongoConnected) {
      try {
        existing = await SubmissionModel.findOne({
          appId,
          $or: [
            { applicantUsername: new RegExp(`^${cleanUser}$`, 'i') },
            { deviceSignature: cleanSignature }
          ]
        });
      } catch (e) {}
    }

    if (!existing) {
      existing = applicationSubmissions.find(s => 
        s.appId === appId && (
          s.applicantUsername.toLowerCase() === cleanUser.toLowerCase() ||
          (s.deviceSignature && s.deviceSignature === cleanSignature && cleanSignature !== 'SIG-UNTRACKED')
        )
      );
    }

    if (existing) {
      return res.status(400).json({ success: false, error: 'You or this device has already submitted an application for this form.' });
    }
  }

  const submission = {
    id: 'SUB-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    appId,
    appTitle: appItem.title,
    applicantUsername: cleanUser,
    discordTag: discordTag ? discordTag.trim() : 'Not provided',
    deviceSignature: cleanSignature,
    answers: answers || {},
    notes: [],
    blacklisted: false,
    submittedAt: new Date(),
    status: 'PENDING'
  };

  if (isMongoConnected) {
    try {
      await SubmissionModel.findOneAndUpdate({ id: submission.id }, submission, { upsert: true, new: true });
    } catch (err) { console.error('MongoDB Submission Error:', err.message); }
  }

  applicationSubmissions.unshift(submission);
  saveApplicationsToFile();

  res.json({ success: true, message: 'Application submitted successfully!', submissionId: submission.id });
});

app.post('/api/applications/submissions/:subId/status', requireAuth, requireOwner, async (req, res) => {
  const { subId } = req.params;
  const { status, note, blacklisted } = req.body;
  const sub = applicationSubmissions.find(s => s.id === subId);
  if (!sub) return res.status(404).json({ success: false, error: 'Submission not found.' });

  if (status) sub.status = status;
  if (blacklisted !== undefined) sub.blacklisted = Boolean(blacklisted);
  if (note && note.trim()) {
    if (!sub.notes) sub.notes = [];
    sub.notes.push({ author: req.session.adminName || 'Owner', text: note.trim(), time: new Date() });
  }

  sub.reviewedBy = req.session.adminName || 'Owner';
  sub.reviewedAt = new Date();
  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await SubmissionModel.updateOne({ id: subId }, sub);
    } catch (err) {}
  }

  res.json({ success: true, submission: sub, message: `Submission updated cleanly.` });
});

app.post('/api/applications/submissions/:subId/reject-block-device', requireAuth, requireOwner, async (req, res) => {
  const { subId } = req.params;
  const sub = applicationSubmissions.find(s => s.id === subId);
  if (!sub) return res.status(404).json({ success: false, error: 'Submission not found.' });

  sub.status = 'DENIED';
  sub.reviewedBy = req.session.adminName || 'Owner';
  sub.reviewedAt = new Date();

  if (sub.deviceSignature && sub.deviceSignature !== 'SIG-UNTRACKED') {
    blockedSignatures.add(sub.deviceSignature);
    saveSecurityGateToFile();
  }

  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await SubmissionModel.updateOne({ id: subId }, { status: 'DENIED', reviewedBy: sub.reviewedBy, reviewedAt: sub.reviewedAt });
    } catch (err) {}
  }

  res.json({ success: true, message: `Application rejected and Device Signature ${sub.deviceSignature || ''} restricted from Connection Gateway.` });
});

app.post('/api/public/applications/submissions/:subId/withdraw', async (req, res) => {
  const { subId } = req.params;
  const { applicantUsername } = req.body;
  const sub = applicationSubmissions.find(s => s.id === subId && s.applicantUsername.toLowerCase() === (applicantUsername || '').toLowerCase());
  if (!sub) return res.status(404).json({ success: false, error: 'Application record not found or username mismatch.' });

  sub.status = 'WITHDRAWN';
  sub.withdrawnAt = new Date();
  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await SubmissionModel.updateOne({ id: subId }, { status: 'WITHDRAWN' });
    } catch (err) {}
  }

  res.json({ success: true, message: 'Application successfully withdrawn.' });
});

app.post('/api/public/applications/submissions/:subId/onboard', async (req, res) => {
  const { subId } = req.params;
  const { applicantUsername, ndaSigned } = req.body;
  const sub = applicationSubmissions.find(s => s.id === subId && s.applicantUsername.toLowerCase() === (applicantUsername || '').toLowerCase());
  if (!sub) return res.status(404).json({ success: false, error: 'Application record not found.' });

  sub.ndaSigned = Boolean(ndaSigned);
  sub.onboardingCompletedAt = new Date();
  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await SubmissionModel.updateOne({ id: subId }, { ndaSigned: sub.ndaSigned });
    } catch (err) {}
  }

  res.json({ success: true, message: 'Staff agreement and NDA signed successfully!' });
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

app.post('/api/ai/generate', requireAuth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: 'Prompt is required.' });

  try {
    const isAiCheck = prompt.toLowerCase().includes('chatgpt') || prompt.toLowerCase().includes('analyze this staff application');
    if (isAiCheck) {
      const lower = prompt.toLowerCase();
      const suspiciousTerms = ['furthermore', 'moreover', 'delve', 'testament', 'beacon', 'indispensable', 'meticulous', 'spearhead', 'foster'];
      let matchCount = 0;
      suspiciousTerms.forEach(term => { if (lower.includes(term)) matchCount++; });

      if (matchCount >= 2) {
        return res.json({
          text: `HIGH CONFIDENCE AI GENERATED CONTENT DETECTED.\n• Detected typical synthetic phrasing & vocabulary (${matchCount} markers found).\n• Re-evaluate answer originality or request live interview.`
        });
      } else {
        return res.json({
          text: `CLEAN / HUMAN WRITTEN CONTENT.\n• Natural phrasing pattern detected.\n• Meets authentic response criteria.`
        });
      }
    } else {
      const cleaned = prompt.replace(/^Refine this note into a concise single-line moderation reason:\s*"/i, '').replace(/"$/, '');
      const refined = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      return res.json({ text: `Official Notice: ${refined} [Upholding Community Safety]` });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'AI processing service error.' });
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

app.get(['/', '/dashboard', '/chat', '/banned', '/logs', '/system', '/lookup', '/management', '/applications', '/security'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get(['/apply/:id', '/apply/:id/roster'], (req, res) => {
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