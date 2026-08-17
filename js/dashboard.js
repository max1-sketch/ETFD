let localLogs = [];

// Toast notification helper with dynamic container fallback
function showToast(message, type = 'success') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-circle-xmark';
  if (type === 'info') icon = 'fa-circle-info';

  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Tab navigation handler
function switchTab(evt, tabName) {
  document.querySelectorAll('.tab-page').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));

  const target = document.getElementById(`tab-${tabName}`);
  if (target) target.classList.add('active');
  if (evt && evt.currentTarget) evt.currentTarget.classList.add('active');
}

// Execute remote action to backend API
async function sendAction(actionType) {
  const userIdInput = document.getElementById('userId');
  const reasonInput = document.getElementById('reason');
  const toolNameInput = document.getElementById('toolName');

  const userId = userIdInput.value.trim();
  const reason = reasonInput.value.trim();
  const toolName = toolNameInput.value.trim();

  if (!userId) {
    showToast('Please enter a Target Roblox UserID!', 'error');
    userIdInput.focus();
    return;
  }

  showToast(`Dispatching ${actionType} command...`, 'info');

  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: actionType, userId, reason, toolName })
    });

    const data = await res.json();

    if (res.ok && data.success) {
      showToast(`${actionType} command sent to UserID ${userId}!`, 'success');
      reasonInput.value = '';
      toolNameInput.value = '';
      loadLogs();
    } else {
      showToast(data.error || data.message || 'Action failed to process.', 'error');
    }
  } catch (err) {
    console.error('API Error:', err);
    showToast('Cannot reach server. Is node server.js running?', 'error');
  }
}

// Fetch logs and update interface stats
async function loadLogs() {
  try {
    const res = await fetch('/api/logs');
    if (!res.ok) return;
    const data = await res.json();
    localLogs = data.logs || [];
    renderLogs(localLogs);
    updateStats(localLogs);
  } catch (err) {
    console.error('Log load error:', err);
  }
}

function renderLogs(logs) {
  const recentContainer = document.getElementById('recentActivityList');
  const fullContainer = document.getElementById('fullActivityList');

  if (!logs || logs.length === 0) {
    const emptyHtml = '<div class="empty-state">No moderation commands logged yet.</div>';
    if (recentContainer) recentContainer.innerHTML = emptyHtml;
    if (fullContainer) fullContainer.innerHTML = emptyHtml;
    return;
  }

  const buildRow = item => `
    <div class="activity-item">
      <div>
        <span class="act-badge act-${item.action}">${item.action}</span>
        <strong>Target ID: ${item.userId}</strong>
        ${item.reason ? `<span class="log-note">— "${item.reason}"</span>` : ''}
        ${item.toolName ? `<span class="log-tool">[Tool: ${item.toolName}]</span>` : ''}
      </div>
      <span class="act-time">${new Date(item.timestamp).toLocaleTimeString()}</span>
    </div>
  `;

  if (recentContainer) recentContainer.innerHTML = logs.slice(0, 5).map(buildRow).join('');
  if (fullContainer) fullContainer.innerHTML = logs.map(buildRow).join('');
}

function updateStats(logs) {
  const total = document.getElementById('stat-total');
  const punishments = document.getElementById('stat-punishments');
  const warnings = document.getElementById('stat-warnings');
  const tools = document.getElementById('stat-tools');

  if (total) total.innerText = logs.length;
  if (punishments) punishments.innerText = logs.filter(l => l.action === 'KICK' || l.action === 'BAN').length;
  if (warnings) warnings.innerText = logs.filter(l => l.action === 'WARN').length;
  if (tools) tools.innerText = logs.filter(l => l.action === 'REMOVE_TOOL').length;
}

function filterLogs() {
  const query = document.getElementById('globalSearch').value.toLowerCase();
  const filtered = localLogs.filter(l => 
    l.userId.toString().includes(query) || 
    l.action.toLowerCase().includes(query) ||
    (l.reason && l.reason.toLowerCase().includes(query))
  );
  renderLogs(filtered);
}

// Initial load
document.addEventListener('DOMContentLoaded', loadLogs);