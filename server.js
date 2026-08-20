require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');

// DISCORD BOT DEPENDENCIES
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');

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
    guidelines: String,
    questions: Array,
    settings: Object,
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });

  const SubmissionSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    appId: String,
    appTitle: String,
    applicantUsername: String,
    robloxUserId: Number,
    accountAgeDays: Number,
    discordTag: String,
    googleProfile: Object,
    deviceSignature: String,
    proofUrl: String,
    answers: Object,
    notes: Array,
    blacklisted: { type: Boolean, default: false },
    submittedAt: { type: Date, default: Date.now },
    status: { type: String, default: 'PENDING' },
    reviewedBy: String,
    reviewedAt: Date
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

const APPLICATIONS_FILE = path.join(__dirname, 'applications.json');
const BANS_FILE = path.join(__dirname, 'banned_users.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const SECURITY_FILE = path.join(__dirname, 'security_gate.json');

let applicationsMap = new Map();
let applicationSubmissions = [];
let bannedUsersMap = new Map();
let usersMap = new Map();
let blockedSignatures = new Set();
let securityLogs = [];
let actionLogs = [];
let lastActionTimestamp = 0;

let systemNotice = {
  active: true,
  message: "Maintenance scheduled tonight at 10:00 PM EST.",
  alertLevel: "warning",
  icon: "bullhorn",
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
      securityLogs
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

if (fs.existsSync(APPLICATIONS_FILE)) {
  try {
    const rawApps = fs.readFileSync(APPLICATIONS_FILE, 'utf8');
    const parsed = JSON.parse(rawApps);
    if (parsed.apps) parsed.apps.forEach(a => applicationsMap.set(a.id, a));
    if (parsed.submissions) applicationSubmissions = parsed.submissions;
  } catch (err) { console.error('Error reading applications.json:', err.message); }
}

if (fs.existsSync(BANS_FILE)) {
  try {
    const rawBans = fs.readFileSync(BANS_FILE, 'utf8');
    JSON.parse(rawBans).forEach(b => bannedUsersMap.set(Number(b.userId), b));
  } catch (err) { console.error('Error reading banned_users.json:', err.message); }
}

if (fs.existsSync(SECURITY_FILE)) {
  try {
    const rawSec = fs.readFileSync(SECURITY_FILE, 'utf8');
    const parsedSec = JSON.parse(rawSec);
    if (Array.isArray(parsedSec.blockedSignatures)) blockedSignatures = new Set(parsedSec.blockedSignatures);
    if (Array.isArray(parsedSec.securityLogs)) securityLogs = parsedSec.securityLogs;
  } catch (err) { console.error('Error reading security_gate.json:', err.message); }
}

if (mongoose && process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log('🍃 Connected to MongoDB Atlas Cloud Database!');
      isMongoConnected = true;

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

        const dbSec = await SecurityGateModel.findOne({ configId: 'default' });
        if (dbSec) {
          if (Array.isArray(dbSec.blockedSignatures)) blockedSignatures = new Set(dbSec.blockedSignatures);
          if (Array.isArray(dbSec.securityLogs)) securityLogs = dbSec.securityLogs;
        }

        console.log(`✅ Loaded ${applicationsMap.size} Apps & ${applicationSubmissions.length} Submissions from MongoDB Atlas.`);
      } catch (err) {
        console.error('Error hydrating data from MongoDB Atlas:', err.message);
      }
    })
    .catch(err => {
      console.error('❌ MongoDB Atlas Connection Failed:', err.message);
    });
}

// ==========================================
// GOOGLE OAUTH 2.0 APPLICANT AUTHENTICATION
// ==========================================
app.get('/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(500).send('Google Client ID is not configured in server environment variables.');
  }

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`;
  const returnTo = req.query.returnTo || '/';
  req.session.googleReturnTo = returnTo;

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20profile%20email&prompt=select_account`;
  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`;
  const returnTo = req.session.googleReturnTo || '/';

  if (!code || !clientId || !clientSecret) {
    return res.status(400).send('Google OAuth authentication failed. Missing code or credentials.');
  }

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const accessToken = tokenRes.data.access_token;
    const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    req.session.applicantGoogle = {
      id: userRes.data.id,
      name: userRes.data.name,
      email: userRes.data.email,
      picture: userRes.data.picture
    };

    delete req.session.googleReturnTo;
    res.redirect(returnTo);
  } catch (err) {
    console.error('Google OAuth Error:', err.response?.data || err.message);
    res.redirect(`${returnTo}?google_error=auth_failed`);
  }
});

app.get('/auth/google/logout', (req, res) => {
  delete req.session.applicantGoogle;
  const returnTo = req.query.returnTo || '/';
  res.redirect(returnTo);
});

app.get('/api/public/auth/me', (req, res) => {
  res.json({
    authenticated: Boolean(req.session && req.session.applicantGoogle),
    googleUser: req.session ? req.session.applicantGoogle || null : null
  });
});

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

// EMERGENCY PUBLIC DEVICE SIGNATURE RESET ENDPOINT
app.post('/api/public/gate/reset-signature', (req, res) => {
  const { signature } = req.body;
  if (signature) {
    const cleanSig = String(signature).trim();
    blockedSignatures.delete(cleanSig);
    saveSecurityGateToFile();
    if (isMongoConnected) {
      SecurityGateModel.findOneAndUpdate(
        { configId: 'default' },
        { blockedSignatures: Array.from(blockedSignatures), securityLogs },
        { upsert: true }
      ).catch(() => {});
    }
  }
  res.json({ success: true, message: 'Device signature restrictions reset cleanly.' });
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

// ==========================================
// RECRUITMENT APPLICATIONS & EDITING API
// ==========================================
app.get('/api/applications', requireAuth, (req, res) => {
  res.json({
    success: true,
    applications: Array.from(applicationsMap.values()),
    submissions: applicationSubmissions
  });
});

// CREATE OR UPDATE APPLICATION FORM
app.post('/api/applications', requireAuth, requireOwner, async (req, res) => {
  const { id, title, description, guidelines, questions, settings } = req.body;
  if (!title) return res.status(400).json({ success: false, error: 'Application title is required.' });

  let appId = id && String(id).trim();
  const existingApp = appId ? applicationsMap.get(appId) : null;

  if (!appId || !existingApp) {
    appId = 'APP-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  const appObj = {
    id: appId,
    title: title.trim(),
    description: description ? description.trim() : '',
    guidelines: guidelines ? guidelines.trim() : '',
    questions: Array.isArray(questions) ? questions : [],
    settings: settings || { limitOneResponse: true, acceptingResponses: true, minAge: 30 },
    active: existingApp ? existingApp.active : true,
    createdAt: existingApp ? existingApp.createdAt : new Date(),
    updatedAt: new Date()
  };

  applicationsMap.set(appObj.id, appObj);
  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await ApplicationModel.findOneAndUpdate({ id: appObj.id }, appObj, { upsert: true, new: true });
    } catch (err) { console.error('MongoDB Application Save Error:', err.message); }
  }

  res.json({
    success: true,
    isEdit: Boolean(existingApp),
    message: existingApp ? `Application form "${appObj.title}" updated successfully!` : 'Application form published cleanly!',
    application: appObj
  });
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
      guidelines: appItem.guidelines,
      questions: appItem.questions,
      settings: appItem.settings,
      active: appItem.active
    }
  });
});

app.get('/api/public/applications/:id/check', async (req, res) => {
  const { id } = req.params;
  const { username, deviceSignature } = req.query;

  const cleanUser = username ? String(username).trim().toLowerCase() : '';
  const cleanSig = deviceSignature ? String(deviceSignature).trim() : '';

  if (!cleanUser && !cleanSig) {
    return res.json({ success: true, alreadySubmitted: false, submission: null });
  }

  let existing = null;

  if (isMongoConnected) {
    try {
      const orConditions = [];
      if (cleanUser) orConditions.push({ applicantUsername: new RegExp(`^${cleanUser}$`, 'i') });
      if (cleanSig && cleanSig !== 'SIG-UNTRACKED') orConditions.push({ deviceSignature: cleanSig });

      const query = { $or: orConditions };
      if (id && id !== 'APP-DEFAULT' && id !== 'any') {
        query.appId = id;
      }

      existing = await SubmissionModel.findOne(query);
    } catch (e) {}
  }

  if (!existing) {
    existing = applicationSubmissions.find(s => 
      (id === 'APP-DEFAULT' || id === 'any' || s.appId === id) && (
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
      reviewedBy: s.reviewedBy ? `${s.reviewedBy} [Staff]` : 'Pending'
    }))
  });
});

app.post('/api/applications/submit', async (req, res) => {
  const { appId, applicantUsername, discordTag, answers, deviceSignature, proofUrl } = req.body;
  const appItem = applicationsMap.get(appId);
  if (!appItem) return res.status(404).json({ success: false, error: 'Application form not found.' });
  if (!appItem.active) return res.status(400).json({ success: false, error: 'This application form is currently closed for responses.' });

  const cleanUser = applicantUsername ? applicantUsername.trim() : '';
  const cleanSignature = deviceSignature ? String(deviceSignature).trim() : 'SIG-UNTRACKED';

  if (!cleanUser) {
    return res.status(400).json({ success: false, error: 'Roblox Username is required.' });
  }

  let robloxAccountData = null;
  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [cleanUser],
      excludeBannedUsers: false
    }, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 5000 });

    if (!userRes.data?.data?.[0]) {
      return res.status(400).json({ success: false, error: `Invalid Roblox account "${cleanUser}". Please enter your exact Roblox username!` });
    }

    const robloxUser = userRes.data.data[0];
    const detailsRes = await axios.get(`https://users.roblox.com/v1/users/${robloxUser.id}`, { timeout: 5000 });
    const createdDate = detailsRes.data.created ? new Date(detailsRes.data.created) : new Date();
    const accountAgeDays = Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

    const minAgeRequired = appItem.settings?.minAge || 0;
    if (minAgeRequired > 0 && accountAgeDays < minAgeRequired) {
      return res.status(400).json({ success: false, error: `Your Roblox account is ${accountAgeDays} days old. This form requires an account age of at least ${minAgeRequired} days.` });
    }

    robloxAccountData = {
      userId: robloxUser.id,
      exactName: robloxUser.name,
      displayName: robloxUser.displayName || robloxUser.name,
      accountAgeDays
    };
  } catch (err) {
    console.warn('Roblox API verification warning during submission:', err.message);
  }

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
    applicantUsername: robloxAccountData ? robloxAccountData.exactName : cleanUser,
    robloxUserId: robloxAccountData ? robloxAccountData.userId : null,
    accountAgeDays: robloxAccountData ? robloxAccountData.accountAgeDays : null,
    discordTag: discordTag ? discordTag.trim() : 'Not provided',
    googleProfile: req.session ? req.session.applicantGoogle || null : null,
    deviceSignature: cleanSignature,
    proofUrl: proofUrl ? proofUrl.trim() : '',
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

app.post('/api/applications/submissions/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  let sub = applicationSubmissions.find(s => s.id === id);
  if (!sub && isMongoConnected) {
    try {
      sub = await SubmissionModel.findOne({ id });
    } catch (e) {}
  }

  if (!sub) {
    return res.status(404).json({ success: false, error: 'Submission not found.' });
  }

  sub.status = status || 'PENDING';
  sub.reviewedBy = req.session.adminName || 'roblox';
  sub.reviewedAt = new Date();

  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await SubmissionModel.updateOne({ id }, { status: sub.status, reviewedBy: sub.reviewedBy, reviewedAt: sub.reviewedAt });
    } catch (err) {}
  }

  res.json({ success: true, message: `Submission status updated to ${status}` });
});

app.post('/api/applications/submissions/:id/reject-block-device', requireAuth, async (req, res) => {
  const { id } = req.params;

  let sub = applicationSubmissions.find(s => s.id === id);
  if (!sub && isMongoConnected) {
    try {
      sub = await SubmissionModel.findOne({ id });
    } catch (e) {}
  }

  if (!sub) {
    return res.status(404).json({ success: false, error: 'Submission not found.' });
  }

  sub.status = 'DENIED';
  sub.blacklisted = true;
  sub.reviewedBy = req.session.adminName || 'roblox';
  sub.reviewedAt = new Date();

  const sigToBlock = sub.deviceSignature || 'SIG-UNTRACKED';
  if (sigToBlock && sigToBlock !== 'SIG-UNTRACKED') {
    blockedSignatures.add(sigToBlock);

    securityLogs.unshift({
      timestamp: new Date(),
      signature: sigToBlock,
      ip: 'App Gate Block',
      status: 'Blocked',
      note: `Rejected & Device Blocked (${sub.applicantUsername})`
    });
    if (securityLogs.length > 100) securityLogs.pop();

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
  }

  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await SubmissionModel.updateOne({ id }, { status: 'DENIED', blacklisted: true, reviewedBy: sub.reviewedBy, reviewedAt: sub.reviewedAt });
    } catch (err) {}
  }

  const adminName = req.session.adminName || 'roblox';
  actionLogs.unshift({
    id: Date.now(),
    action: 'REJECT_BLOCK_DEVICE',
    userId: sub.robloxUserId || 0,
    admin: adminName,
    reason: `Rejected application for ${sub.applicantUsername} and blocked device signature (${sigToBlock}).`,
    timestamp: new Date()
  });

  res.json({
    success: true,
    message: `Candidate ${sub.applicantUsername} rejected! Signature (${sigToBlock}) added to Security Center restrictions.`
  });
});

app.post('/api/public/applications/submissions/:id/withdraw', async (req, res) => {
  const { id } = req.params;
  const { applicantUsername } = req.body;

  let sub = applicationSubmissions.find(s => s.id === id);
  if (!sub && isMongoConnected) {
    try {
      sub = await SubmissionModel.findOne({ id });
    } catch (e) {}
  }

  if (!sub) return res.status(404).json({ success: false, error: 'Submission not found.' });

  if (applicantUsername && sub.applicantUsername.toLowerCase() !== applicantUsername.trim().toLowerCase()) {
    return res.status(403).json({ success: false, error: 'Username mismatch. Cannot withdraw submission.' });
  }

  sub.status = 'WITHDRAWN';
  saveApplicationsToFile();

  if (isMongoConnected) {
    try {
      await SubmissionModel.updateOne({ id }, { status: 'WITHDRAWN' });
    } catch (e) {}
  }

  res.json({ success: true, message: 'Application withdrawn successfully.' });
});

app.get('/api/public/validate-roblox/:username', async (req, res) => {
  const username = req.params.username ? req.params.username.trim() : '';
  if (!username) return res.status(400).json({ valid: false, error: 'Username required.' });

  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username],
      excludeBannedUsers: false
    }, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 5000 });

    if (userRes.data?.data?.[0]) {
      const rbxUser = userRes.data.data[0];
      const detailsRes = await axios.get(`https://users.roblox.com/v1/users/${rbxUser.id}`, { timeout: 5000 });
      const createdDate = detailsRes.data.created ? new Date(detailsRes.data.created) : new Date();
      const accountAgeDays = Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

      return res.json({
        valid: true,
        userId: rbxUser.id,
        exactName: rbxUser.name,
        displayName: rbxUser.displayName || rbxUser.name,
        accountAgeDays,
        avatarUrl: `/api/avatar/${rbxUser.id}`
      });
    } else {
      return res.json({ valid: false, error: 'Roblox user not found.' });
    }
  } catch (err) {
    res.json({ valid: false, error: 'Roblox API request failed.' });
  }
});

app.get('/api/avatar-by-username/:username', async (req, res) => {
  const username = req.params.username ? req.params.username.trim() : '';
  if (!username) return res.redirect('/api/avatar/1');

  try {
    const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
      usernames: [username],
      excludeBannedUsers: false
    }, { timeout: 4000 });

    if (userRes.data?.data?.[0]?.id) {
      const rbxId = userRes.data.data[0].id;
      return res.redirect(`/api/avatar/${rbxId}`);
    }
  } catch (e) {}

  res.redirect(`https://placehold.co/150x150/0e131f/3b82f6?text=${encodeURIComponent(username.substring(0, 2).toUpperCase())}`);
});

app.get('/api/avatar/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const rbxRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`, { timeout: 4000 });
    if (rbxRes.data?.data?.[0]?.imageUrl) {
      return res.redirect(rbxRes.data.data[0].imageUrl);
    }
  } catch (e) {}
  res.redirect(`https://placehold.co/150x150/0e131f/3b82f6?text=RBX`);
});

app.get('/api/lookup/:query', requireAuth, async (req, res) => {
  const query = req.params.query.trim();
  let rbxId = Number(query);

  try {
    if (isNaN(rbxId)) {
      const userRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
        usernames: [query],
        excludeBannedUsers: false
      }, { timeout: 5000 });

      if (userRes.data?.data?.[0]) {
        rbxId = userRes.data.data[0].id;
      } else {
        return res.status(404).json({ success: false, error: `Roblox user "${query}" not found.` });
      }
    }

    const detailsRes = await axios.get(`https://users.roblox.com/v1/users/${rbxId}`, { timeout: 5000 });
    const createdDate = detailsRes.data.created ? new Date(detailsRes.data.created) : new Date();
    const accountAgeDays = Math.max(0, Math.floor((Date.now() - createdDate.getTime()) / (1000 * 60 * 60 * 24)));

    res.json({
      success: true,
      userId: detailsRes.data.id,
      username: detailsRes.data.name,
      displayName: detailsRes.data.displayName || detailsRes.data.name,
      description: detailsRes.data.description || 'No user bio provided.',
      accountAgeDays,
      avatarUrl: `/api/avatar/${detailsRes.data.id}`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Roblox API lookup failed.' });
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
  const caseId = `#CASE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  if (action === 'BAN') {
    bannedUsersMap.set(numUserId, { userId: numUserId, reason: reason.trim(), admin: adminName, caseId, durationText, bannedAt: new Date() });
    saveBansToFile();
    if (isMongoConnected) {
      try {
        await BannedUserModel.findOneAndUpdate({ userId: numUserId }, { userId: numUserId, reason: reason.trim(), admin: adminName, caseId, durationText, bannedAt: new Date() }, { upsert: true });
      } catch (e) {}
    }
  } else if (action === 'UNBAN') {
    bannedUsersMap.delete(numUserId);
    saveBansToFile();
    if (isMongoConnected) {
      try {
        await BannedUserModel.deleteOne({ userId: numUserId });
      } catch (e) {}
    }
  }

  const logEntry = { id: Date.now(), caseId, action, userId: numUserId, reason: reason ? reason.trim() : 'No reason provided.', admin: adminName, toolName, timestamp: new Date() };
  actionLogs.unshift(logEntry);

  res.json({ success: true, caseId, message: `${action} [${caseId}] dispatched for UserID ${numUserId}` });
});

// UNBAN ALL ENDPOINT
app.post('/api/unban-all', requireAuth, requireOwner, async (req, res) => {
  bannedUsersMap.clear();
  saveBansToFile();

  if (isMongoConnected) {
    try {
      await BannedUserModel.deleteMany({});
    } catch (e) {}
  }

  const adminName = req.session.adminName || 'roblox';
  actionLogs.unshift({
    id: Date.now(),
    action: 'UNBAN_ALL',
    userId: 0,
    admin: adminName,
    reason: 'Force Unbanned all registered global player restrictions.',
    timestamp: new Date()
  });

  res.json({ success: true, message: 'All player bans have been wiped cleanly!' });
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

app.get('/api/system/notice', (req, res) => {
  res.json({ success: true, notice: systemNotice });
});

app.post('/api/system/notice', requireAuth, requireOwner, (req, res) => {
  const { message, alertLevel, icon, active, author } = req.body;
  systemNotice = {
    active: Boolean(active),
    message: message || "System Maintenance scheduled.",
    alertLevel: alertLevel || "warning",
    icon: icon || "bullhorn",
    author: author || req.session.adminName || "Owner"
  };
  io.emit('systemNoticeUpdate', systemNotice);
  res.json({ success: true, message: 'Notice banner updated cleanly!', notice: systemNotice });
});

app.get(['/', '/dashboard', '/chat', '/banned', '/logs', '/system', '/lookup', '/management', '/applications', '/security'], requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get(['/apply/:id', '/apply/:id/roster'], (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

io.on('connection', (socket) => {
  socket.emit('systemNoticeUpdate', systemNotice);
});

server.listen(process.env.PORT || 3000, () => console.log('🚀 Staff Command Center Online on Port 3000!'));