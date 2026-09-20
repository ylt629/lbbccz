// ============================================================
// 0. 前端统一日志与异常捕获机制 (ErrorBoundary Equivalent)
// ============================================================

// 静默上报错误到后端，决不阻塞或导致页面崩溃
function reportErrorToBackend(error_type, error_msg, stack_trace, request_params = null) {
  try {
    // 敏感信息脱敏处理
    let safeParams = null;
    if (request_params) {
      safeParams = JSON.parse(JSON.stringify(request_params)); // 深拷贝
      ['password', 'oldPassword', 'newPassword', 'token', 'authorization'].forEach(key => {
        if (safeParams[key]) safeParams[key] = '******';
      });
    }

    const payload = {
      error_type,
      error_msg,
      stack_trace: stack_trace || 'No stack trace available',
      page_url: window.location.href,
      user_agent: navigator.userAgent,
      request_params: safeParams
    };

    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem('liquid_admin_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // Fire and forget: 使用 fetch 但不 await，静默捕获自身的异常
    fetch('/api/logs/frontend', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    }).catch(() => { /* 若日志服务宕机，绝对不能报错影响业务 */ });
  } catch (e) {
    console.error('Logger failure:', e); // 极端情况回退至控制台
  }
}

// 捕获全局 JavaScript 运行异常
window.onerror = function(message, source, lineno, colno, error) {
  const stack = error ? error.stack : `${source}:${lineno}:${colno}`;
  reportErrorToBackend('JS_Exception', message, stack);
  return false; // 不阻止浏览器默认的控制台报错
};

// 捕获未处理的 Promise 异常 (如 async/await 报错没 catch)
window.addEventListener('unhandledrejection', function(event) {
  const msg = event.reason ? (event.reason.message || event.reason.toString()) : 'Unknown Promise Rejection';
  const stack = event.reason && event.reason.stack ? event.reason.stack : 'No stack';
  reportErrorToBackend('Promise_Rejection', msg, stack);
});


// ============================================================
// 1. JWT 身份认证拦截与 API 请求封装
// ============================================================
const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('liquid_admin_token');
}

function checkAuth() {
  if (!getToken()) window.location.href = '/login.html';
}
checkAuth();

// 统一的 Fetch 封装 (带 Token、401拦截及 HTTP 异常自动上报)
async function fetchAPI(url, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let parsedParams = null;
  if (options.body) {
    try { parsedParams = JSON.parse(options.body); } catch (e) { parsedParams = options.body; }
  }

  try {
    const response = await fetch(API_BASE + url, { ...options, headers });
    
    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem('liquid_admin_token');
      window.location.href = '/login.html';
      return null;
    }

    if (!response.ok) {
      const errText = await response.text();
      reportErrorToBackend(`HTTP_${response.status}_Error`, `API Request Failed: ${url}`, errText, parsedParams);
      try { 
        return JSON.parse(errText); 
      } catch (e) { 
        return { success: false, error: errText }; 
      }
    }

    return await response.json();
  } catch (error) {
    reportErrorToBackend('Network_Fetch_Exception', error.message, error.stack, parsedParams);
    console.error('API Fetch Error:', error);
    return null;
  }
}


document.addEventListener('DOMContentLoaded', async function () {
  
  // ============================================================
  // 2. 基础系统、导航与视图路由控制
  // ============================================================
  const root = document.documentElement;
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const backdrop = document.getElementById('sidebar-backdrop');
  const themeBtn = document.getElementById('theme-switch-btn');
  const themeText = themeBtn.querySelector('.theme-text');
  const navLinks = document.querySelectorAll('.nav-link');
  const appViews = document.querySelectorAll('.app-view');

  const toast = document.getElementById('system-toast');
  const toastText = document.getElementById('toast-text');
  const toastDot = document.getElementById('toast-dot');
  
  function showToast(msg, type = 'success') {
    toastText.textContent = msg;
    toast.className = 'glass-toast is-visible';
    toastDot.style.background = type === 'error' ? 'var(--system-red)' : type === 'warning' ? 'var(--system-orange)' : 'var(--system-green)';
    toastDot.style.boxShadow = `0 0 8px ${toastDot.style.background}`;
    setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }

  toggleBtn.addEventListener('click', () => sidebar.classList.toggle('is-expanded'));
  if (backdrop) backdrop.addEventListener('click', () => sidebar.classList.remove('is-expanded'));

  navLinks.forEach((link) => {
    link.addEventListener('click', function () {
      const viewKey = this.getAttribute('data-view');
      navLinks.forEach((item) => item.classList.remove('is-active'));
      this.classList.add('is-active');

      appViews.forEach((v) => v.classList.remove('is-active'));
      const targetView = document.getElementById(`view-${viewKey}`);
      if (targetView) targetView.classList.add('is-active');
      
      if (viewKey === 'profile') loadUserProfile();
      if (viewKey === 'logs') loadSystemLogs();
      if (viewKey === 'schedule') renderGanttBoard();
      if (viewKey === 'devices') renderCards();
    });
  });

  const globalUserBtn = document.getElementById('global-user-btn');
  if (globalUserBtn) {
    globalUserBtn.addEventListener('click', () => {
      const profileNav = document.getElementById('nav-profile');
      if (profileNav) profileNav.click();
    });
  }

  themeBtn.addEventListener('click', function () {
    const cur = root.getAttribute('data-theme') || 'light';
    const next = cur === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    localStorage.setItem('liquid_admin_theme', next);
    if (themeText) themeText.textContent = next === 'dark' ? '浅色模式' : '深色模式';
  });


  // ============================================================
  // 3. 个人中心 (Profile) 业务逻辑
  // ============================================================
  const tabBtns = document.querySelectorAll('.profile-tab-btn');
  const tabContents = document.querySelectorAll('.profile-tab-content');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('is-active'));
      tabContents.forEach(c => c.classList.remove('is-active'));
      btn.classList.add('is-active');
      const targetTab = document.getElementById(`tab-${btn.getAttribute('data-tab')}`);
      if(targetTab) targetTab.classList.add('is-active');
    });
  });

  async function loadUserProfile() {
    const res = await fetchAPI('/user/profile');
    if (!res || !res.success) return showToast('获取个人资料失败', 'error');
    const u = res.data;

    if (u.role_id === 'SuperAdmin') {
      const logsNav = document.getElementById('nav-logs-container');
      if (logsNav) logsNav.style.display = 'block';
    }

    document.getElementById('global-user-name').textContent = u.name;
    document.getElementById('global-user-role').textContent = u.role_id;
    document.getElementById('global-avatar-txt').textContent = u.avatar && u.avatar.length <= 2 ? u.avatar : u.name.substring(0,1);
    
    document.getElementById('prof-name').textContent = u.name;
    document.getElementById('prof-role').textContent = u.role_id;
    document.getElementById('prof-username').textContent = u.username;
    document.getElementById('prof-emp-id').textContent = u.employee_id;
    document.getElementById('prof-team').textContent = u.team_id || '未分配';
    document.getElementById('prof-avatar-text').textContent = u.avatar && u.avatar.length <= 2 ? u.avatar : u.name.substring(0,1);

    document.getElementById('edit-name').value = u.name;
    document.getElementById('edit-phone').value = u.phone || '';
    document.getElementById('edit-email').value = u.email || '';
    document.getElementById('edit-avatar').value = u.avatar || '';

    const logsTbody = document.getElementById('logs-tbody');
    if (logsTbody) {
      logsTbody.innerHTML = '';
      if (u.login_logs && u.login_logs.length > 0) {
        u.login_logs.forEach(log => {
          const time = new Date(log.login_time).toLocaleString();
          const statColor = log.status === 'success' ? 'var(--system-green)' : log.status === 'logout' ? 'var(--text-tertiary)' : 'var(--system-red)';
          logsTbody.innerHTML += `<tr><td>${time}</td><td>${log.ip}</td><td style="font-size:11px; color:var(--text-tertiary); max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${log.user_agent}">${log.user_agent}</td><td style="color:${statColor}; font-weight:600;">${log.status}</td></tr>`;
        });
      } else {
        logsTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-tertiary);">暂无日志记录</td></tr>`;
      }
    }
  }

  const profileEditForm = document.getElementById('profile-edit-form');
  if (profileEditForm) {
    profileEditForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('edit-name').value.trim(),
        phone: document.getElementById('edit-phone').value.trim(),
        email: document.getElementById('edit-email').value.trim(),
        avatar: document.getElementById('edit-avatar').value.trim()
      };
      const res = await fetchAPI('/user/profile', { method: 'PUT', body: JSON.stringify(payload) });
      if (res && res.success) {
        showToast('个人资料修改成功！');
        loadUserProfile(); 
      } else {
        showToast(res ? res.error : '修改失败', 'error');
      }
    });
  }

  const passwordEditForm = document.getElementById('password-edit-form');
  if (passwordEditForm) {
    passwordEditForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPwd = document.getElementById('edit-old-pwd').value;
      const newPwd = document.getElementById('edit-new-pwd').value;
      const confirmPwd = document.getElementById('edit-confirm-pwd').value;
      
      if (newPwd !== confirmPwd) return showToast('两次输入的新密码不一致！', 'error');
      if (newPwd.length < 6) return showToast('新密码长度不能少于6位', 'error');

      const res = await fetchAPI('/user/password', { method: 'PUT', body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }) });
      if (res && res.success) {
        showToast('密码修改成功，请妥善保管新密码！');
        passwordEditForm.reset();
      } else {
        showToast(res ? res.message : '密码验证失败', 'error');
      }
    });
  }

  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      if (confirm('确认要退出系统吗？')) {
        await fetchAPI('/auth/logout', { method: 'POST' }); 
        localStorage.removeItem('liquid_admin_token');
        window.location.href = '/login.html';
      }
    });
  }


  // ============================================================
  // 4. 日志中心 (Log Center) 业务逻辑
  // ============================================================
  const logTypeSelect = document.getElementById('log-type-select');
  const logSearchInput = document.getElementById('log-search-input');
  const clearLogSearchBtn = document.getElementById('clear-log-search-btn');
  const logsMainThead = document.getElementById('logs-main-thead');
  const logsMainTbody = document.getElementById('logs-main-tbody');
  const logDetailOverlay = document.getElementById('log-detail-overlay');
  
  let currentLogType = 'audit';
  let currentLogKeyword = '';
  let logsDataCache = [];

  if (logTypeSelect) {
    logTypeSelect.addEventListener('change', function() {
      currentLogType = this.value;
      loadSystemLogs();
    });
  }

  if (logSearchInput) {
    logSearchInput.addEventListener('input', function() {
      currentLogKeyword = this.value.trim();
      if (clearLogSearchBtn) clearLogSearchBtn.style.display = currentLogKeyword ? 'flex' : 'none';
      loadSystemLogs();
    });
  }

  if (clearLogSearchBtn) {
    clearLogSearchBtn.addEventListener('click', function() {
      logSearchInput.value = '';
      currentLogKeyword = '';
      this.style.display = 'none';
      loadSystemLogs();
    });
  }

  async function loadSystemLogs() {
    let url = `/logs/${currentLogType}`;
    if (currentLogKeyword) url += `?keyword=${encodeURIComponent(currentLogKeyword)}`;
    
    const res = await fetchAPI(url);
    if (!res || !res.success) {
      if (logsMainTbody) logsMainTbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--system-red);">获取日志失败或权限不足</td></tr>`;
      return;
    }
    
    logsDataCache = res.data;
    renderLogsTable();
  }

  function renderLogsTable() {
    if (!logsMainThead || !logsMainTbody) return;

    if (currentLogType === 'audit') {
      logsMainThead.innerHTML = `<tr><th>时间</th><th>操作人</th><th>模块</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th></tr>`;
      if (logsDataCache.length === 0) return logsMainTbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">暂无日志</td></tr>`;
      
      logsMainTbody.innerHTML = logsDataCache.map((log, index) => `
        <tr>
          <td>${new Date(log.created_at).toLocaleString()}</td>
          <td><strong>${log.username}</strong></td>
          <td><span class="profile-role-badge">${log.module}</span></td>
          <td>${log.action_type}</td>
          <td>${log.target}</td>
          <td style="color: ${log.result === 'success' ? 'var(--system-green)' : 'var(--system-red)'}; font-weight:600;">${log.result}</td>
          <td><button type="button" class="glass-btn btn-secondary log-detail-btn" data-idx="${index}" style="padding: 4px 10px; font-size:11px;">查看参数</button></td>
        </tr>
      `).join('');
    } else if (currentLogType === 'system') {
      logsMainThead.innerHTML = `<tr><th>时间</th><th>级别</th><th>类型</th><th>信息</th><th>详情</th></tr>`;
      if (logsDataCache.length === 0) return logsMainTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;">暂无日志</td></tr>`;
      
      logsMainTbody.innerHTML = logsDataCache.map((log, index) => `
        <tr>
          <td>${new Date(log.created_at).toLocaleString()}</td>
          <td><span class="status-pill ${log.level === 'CRITICAL' ? 'status-maintenance pulse-alert' : log.level==='ERROR'?'status-maintenance' : 'status-idle'}">${log.level}</span></td>
          <td>${log.type}</td>
          <td style="max-width:300px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${log.message}</td>
          <td><button type="button" class="glass-btn btn-secondary log-detail-btn" data-idx="${index}" style="padding: 4px 10px; font-size:11px;">查看</button></td>
        </tr>
      `).join('');
    } else if (currentLogType === 'error') {
      logsMainThead.innerHTML = `<tr><th>时间</th><th>级别</th><th>报错类型</th><th>页面 / API</th><th>错误详情</th><th>追踪</th></tr>`;
      if (logsDataCache.length === 0) return logsMainTbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">暂无日志</td></tr>`;
      
      logsMainTbody.innerHTML = logsDataCache.map((log, index) => `
        <tr>
          <td>${new Date(log.created_at).toLocaleString()}</td>
          <td><span class="status-pill status-maintenance ${log.level==='CRITICAL'?'pulse-alert':''}">${log.level}</span></td>
          <td><strong>${log.error_type}</strong></td>
          <td style="font-size:11px; color:var(--system-blue);">${log.api_url || log.page_url}</td>
          <td style="max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--system-red);">${log.error_msg}</td>
          <td><button type="button" class="glass-btn btn-danger-outline log-detail-btn" data-idx="${index}" style="padding: 4px 10px; font-size:11px;">堆栈 Trace</button></td>
        </tr>
      `).join('');
    }

    document.querySelectorAll('.log-detail-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = e.currentTarget.getAttribute('data-idx');
        showLogDetailModal(logsDataCache[idx]);
      });
    });
  }

  function showLogDetailModal(log) {
    if (!logDetailOverlay) return;
    const modalTitle = document.getElementById('log-modal-title');
    const modalSub = document.getElementById('log-modal-sub');
    const modalContent = document.getElementById('log-modal-content');
    
    modalSub.textContent = `记录时间：${new Date(log.created_at).toLocaleString()}`;
    let html = '';

    if (currentLogType === 'audit') {
      modalTitle.textContent = `操作审计：${log.action_type}`;
      html = `
        <div class="dossier-section">
          <div class="specs-matrix">
            <div class="matrix-row"><span class="matrix-key">操作人 (User ID)</span><span class="matrix-value">${log.username} (${log.user_id})</span></div>
            <div class="matrix-row"><span class="matrix-key">操作模块/对象</span><span class="matrix-value">${log.module} / ${log.target}</span></div>
            <div class="matrix-row"><span class="matrix-key">IP / UA</span><span class="matrix-value" style="font-size:10px;">${log.ip}<br/>${log.user_agent}</span></div>
            <div class="matrix-row"><span class="matrix-key">执行结果</span><span class="matrix-value" style="color:${log.result === 'success'?'var(--system-green)':'var(--system-red)'}">${log.result} ${log.error_msg ? '- '+log.error_msg : ''}</span></div>
          </div>
        </div>
        <div class="dossier-section">
          <h3 class="dossier-section-h3">数据变更 Payload</h3>
          <div style="display:flex; gap:10px;">
            <div style="flex:1; background:rgba(0,0,0,0.03); padding:10px; border-radius:6px; font-size:11px; overflow-x:auto;"><strong>操作前:</strong><br/><pre>${log.old_data || '无'}</pre></div>
            <div style="flex:1; background:rgba(0,122,255,0.05); padding:10px; border-radius:6px; font-size:11px; overflow-x:auto;"><strong>操作后:</strong><br/><pre>${log.new_data || '无'}</pre></div>
          </div>
        </div>
      `;
    } else if (currentLogType === 'system') {
      modalTitle.textContent = `系统级日志：${log.type}`;
      html = `
        <div class="dossier-section">
          <div style="padding:16px; background:var(--glass-input-bg); border-radius:var(--radius-md); font-size:13px; font-weight:600;">${log.message}</div>
          <h3 class="dossier-section-h3" style="margin-top:16px;">元数据 (Metadata)</h3>
          <pre style="background:#1e1e1e; color:#d4d4d4; padding:16px; border-radius:8px; font-size:11px; overflow-x:auto;">${JSON.stringify(JSON.parse(log.metadata || '{}'), null, 2)}</pre>
        </div>
      `;
    } else if (currentLogType === 'error') {
      modalTitle.textContent = `异常追踪：${log.error_type}`;
      html = `
        <div class="dossier-section">
          <div style="padding:16px; background:rgba(255,59,48,0.1); color:var(--system-red); border:1px solid rgba(255,59,48,0.3); border-radius:var(--radius-md); font-size:13px; font-weight:600;">${log.error_msg}</div>
          <div class="specs-matrix" style="margin-top:16px;">
            <div class="matrix-row"><span class="matrix-key">关联用户 (User ID)</span><span class="matrix-value">${log.user_id}</span></div>
            <div class="matrix-row"><span class="matrix-key">触发位置 (Page/API)</span><span class="matrix-value" style="word-break:break-all;">${log.page_url}<br/>${log.api_url}</span></div>
          </div>
          <h3 class="dossier-section-h3" style="margin-top:16px; color:var(--system-red);">Stack Trace</h3>
          <pre style="background:#1e1e1e; color:#f85149; padding:16px; border-radius:8px; font-size:11px; overflow-x:auto; white-space:pre-wrap;">${log.stack_trace}</pre>
          <h3 class="dossier-section-h3" style="margin-top:16px;">Request Params</h3>
          <pre style="background:#1e1e1e; color:#d4d4d4; padding:16px; border-radius:8px; font-size:11px; overflow-x:auto;">${JSON.stringify(JSON.parse(log.request_params || '{}'), null, 2)}</pre>
        </div>
      `;
    }

    modalContent.innerHTML = html;
    logDetailOverlay.classList.add('is-active');
  }

  const closeLogModalBtn = document.getElementById('close-log-modal-btn');
  if (closeLogModalBtn) closeLogModalBtn.addEventListener('click', () => logDetailOverlay.classList.remove('is-active'));


  // ============================================================
  // 5. 数据模型与全维硬件架构 (保留原有所有功能)
  // ============================================================
  const HARDWARE_SCHEMAS = {
    'custom-rig': {
      name: '组装机器/节点',
      groups: [
        { groupTitle: 'CPU 处理器架构', fields: [ { key: 'cpu', label: 'CPU 型号', placeholder: '如：AMD EPYC', required: true, width: 'half' }, { key: 'cpu_cores', label: '核心数', placeholder: '如：192 核心', required: true, width: 'half' }, { key: 'cpu_freq', label: '主频基准', placeholder: '如：2.4GHz', required: true, width: 'half' }, { key: 'cpu_threads', label: '线程数', placeholder: '如：384 线程', required: true, width: 'half' } ] },
        { groupTitle: '图形与存储信息', fields: [ { key: 'gpu', label: 'GPU 显卡/显存', placeholder: '如：RTX 4090', required: false, width: 'half' }, { key: 'ram_spec', label: '内存配置', placeholder: '如：512GB DDR5', required: true, width: 'half' }, { key: 'disk_type', label: '存储架构', placeholder: '如：NVMe RAID1', required: true, width: 'full' } ] }
      ]
    },
    laptop: {
      name: '笔记本',
      groups: [
        { groupTitle: '整机与配件', fields: [ { key: 'brand', label: '品牌名称', placeholder: '如：Apple', required: true, width: 'half' }, { key: 'model', label: '规格型号', placeholder: '如：MBP 16', required: true, width: 'half' }, { key: 'has_power_cable', label: '是否有电源线', type: 'select', options: ['是 (原装电源适配器)', '是 (第三方兼容适配器)', '否 (裸机无电源线)'], required: true, width: 'full' } ] },
        { groupTitle: '核心规格', fields: [ { key: 'cpu', label: 'CPU 型号', placeholder: '如：Apple M3 Max', required: true, width: 'half' }, { key: 'gpu', label: 'GPU 显卡', placeholder: '如：40 核 Apple GPU', required: false, width: 'half' }, { key: 'ram_spec', label: '内存配置', placeholder: '如：128GB 6400MHz', required: true, width: 'half' }, { key: 'screen_res', label: '屏幕物理分辨率', placeholder: '如：3456 x 2234', required: true, width: 'half' } ] }
      ]
    },
    desktop: {
      name: '固定机器',
      groups: [
        { groupTitle: '处理器与显卡', fields: [ { key: 'cpu', label: 'CPU 型号', placeholder: '如：i9-14900K', required: true, width: 'half' }, { key: 'gpu', label: '独立显卡 (GPU)', placeholder: '如：RTX 4080 Super', required: true, width: 'half' }, { key: 'ram_spec', label: '内存配置', placeholder: '如：64GB DDR5', required: true, width: 'half' }, { key: 'disk_type', label: '存储类型', placeholder: '如：1TB NVMe', required: true, width: 'half' } ] }
      ]
    },
    gpu: {
      name: '显卡 (GPU)',
      groups: [
        { groupTitle: 'GPU 核心参数', fields: [ { key: 'gpu_vendor', label: '显卡厂商', placeholder: '如：NVIDIA 原厂', required: true, width: 'half' }, { key: 'gpu_chip', label: 'GPU 核心芯片', placeholder: '如：RTX 4090 D', required: true, width: 'half' }, { key: 'gpu_vram', label: 'GPU 显存及规格', placeholder: '如：24GB GDDR6X', required: true, width: 'full' } ] }
      ]
    },
    monitor: {
      name: '显示器',
      groups: [
        { groupTitle: '显示面板规格', fields: [ { key: 'brand', label: '品牌名称', placeholder: '如：Apple Studio Display', required: true, width: 'half' }, { key: 'size', label: '屏幕尺寸', placeholder: '如：27 英寸 5K', required: true, width: 'half' }, { key: 'resolution', label: '物理分辨率', placeholder: '如：5120 x 2880', required: true, width: 'half' }, { key: 'power', label: '供电类型', placeholder: '如：内置电源', required: true, width: 'half' } ] }
      ]
    }
  };

  let devices = [];
  let reservations = [];
  let assemblyTasks = [];

  const fallbackDevices = [
    { id: 'DEV-RIG-001', name: 'Alpha-Compute-01', category: 'custom-rig', categoryName: '组装机器/节点', status: 'idle', location: 'B3 机房 A-02-14', sn: 'SN-NODE-2024-9981', createdAt: '2024-03-10 09:30:00', creator: 'John Doe', updatedAt: '2024-06-15 16:45:10', updatedBy: 'Alice Chen', specs: { cpu: 'AMD EPYC 9654', cpu_cores: '192 核心', cpu_freq: '2.4GHz 基准', cpu_threads: '384 线程', gpu: 'NVIDIA RTX 4090 24GB', gpu_vram: '24GB GDDR6X', ram_spec: '512GB DDR5', disk_type: '2x 3.84TB U.2 NVMe RAID1' } },
    { id: 'DEV-LAP-002', name: 'MacBook-Pro-Dev-01', category: 'laptop', categoryName: '笔记本', status: 'idle', location: '研发大厅 4F-B03', sn: 'C02G80XZMD6T', createdAt: '2024-03-10 09:30:00', creator: 'John Doe', updatedAt: '2024-06-15 16:45:10', updatedBy: 'Alice Chen', specs: { brand: 'Apple', model: 'MacBook Pro 16', has_power_cable: '是 (原装电源适配器)', cpu: 'Apple M3 Max', cpu_cores: '16 核心 (12P + 4E)', cpu_freq: '3.2GHz 基准', cpu_threads: '16 线程', gpu: '40 核 Apple GPU', gpu_vram: '128GB 统一内存', ram_spec: '128GB 6400MHz', disk_type: '纯固态 NVMe 2TB', screen_res: '3456 x 2234 Liquid XDR' } },
    { id: 'DEV-DSK-003', name: 'CAD-Workstation-01', category: 'desktop', categoryName: '固定机器', status: 'inuse', location: '工业设计中心 2F-A01', sn: 'SN-DELL-WS-89021', createdAt: '2024-02-20 14:00:00', creator: 'John Doe', updatedAt: '2024-05-18 11:42:00', updatedBy: 'Sarah Wu', specs: { cpu: 'Intel Core i9-14900K', cpu_cores: '24 核心', cpu_freq: '3.2GHz / 6.0GHz', cpu_threads: '32 线程', gpu: 'NVIDIA RTX 4080 Super', gpu_vram: '16GB GDDR6X', ram_spec: '64GB DDR5 6000MHz', disk_type: '1TB NVMe + 4TB HDD' } },
    { id: 'DEV-GPU-006', name: 'NVIDIA-H100-SXM5-01', category: 'gpu', categoryName: '显卡 (GPU)', status: 'maintenance', faultReason: '供电相电容异常告警，返厂恒温维保中', location: '超算机房 G-01-Rack (送修中)', sn: 'SN-NV-H100-88412', createdAt: '2024-01-10 16:00:00', creator: 'Admin Mark', updatedAt: '2024-06-12 08:30:10', updatedBy: 'Hardware Team', specs: { cpu: 'N/A (专用计算卡)', gpu_vendor: 'NVIDIA 原厂计算卡', gpu_chip: 'NVIDIA H100 SXM5', gpu: 'NVIDIA H100 Tensor Core', gpu_vram: '80GB HBM3', ram_spec: '80GB HBM3 显存池' } }
  ];

  const fallbackReservations = [
    { id: 'RES-2026-001', deviceId: 'DEV-LAP-002', mountedGpuId: null, startDate: '2026-09-04', endDate: '2026-09-08', applicant: '张伟 (AI系统组)', project: 'CoreML端侧量化加速', purpose: '测试 M3 Max 神经引擎推理能效', customAssembly: { osImage: 'macOS Sonoma 14.5' } }
  ];

  async function fetchBackendData() {
    try {
      const [devRes, resRes] = await Promise.all([
        fetchAPI('/devices'),
        fetchAPI('/reservations')
      ]);
      if (devRes) {
        devices = devRes.map(d => ({ ...d, specs: typeof d.specs === 'string' ? JSON.parse(d.specs) : d.specs }));
      }
      if (resRes) {
        reservations = resRes.map(r => ({ ...r, customAssembly: typeof r.customAssembly === 'string' ? JSON.parse(r.customAssembly) : r.customAssembly }));
      }
      
      if(devices.length === 0) devices = [...fallbackDevices];
      if(reservations.length === 0) reservations = [...fallbackReservations];
    } catch (e) {
      console.warn('API 后端未连接，已自动降级使用本地默认数据');
      devices = [...fallbackDevices];
      reservations = [...fallbackReservations];
    }
    renderGanttBoard();
    renderCards();
    updateBadges();
  }

  function updateBadges() {
    const faultCount = devices.filter((d) => d.status === 'maintenance').length;
    const sidebarFaultBadge = document.getElementById('sidebar-fault-badge');
    const scheduleBadgeCount = document.getElementById('schedule-badge-count');
    const assemblyTaskCount = document.getElementById('assembly-task-count');

    if (sidebarFaultBadge) {
      sidebarFaultBadge.textContent = faultCount;
      sidebarFaultBadge.style.display = faultCount > 0 ? 'inline-block' : 'none';
    }
    if (scheduleBadgeCount) scheduleBadgeCount.textContent = reservations.length;
    if (assemblyTaskCount) {
      assemblyTaskCount.textContent = assemblyTasks.length;
      assemblyTaskCount.style.display = assemblyTasks.length > 0 ? 'inline-block' : 'none';
    }
  }


  // ============================================================
  // 6. 预约排期甘特大盘核心逻辑 (完全恢复的完整版)
  // ============================================================
  let currentBoardYear = 2026;
  let currentBoardMonth = 9;
  let currentScheduleFilterCat = 'all';

  let currentScheduleSearchKeyword = '';
  let currentHwSearchCpu = '';
  let currentHwSearchGpu = '';
  let currentHwSearchRam = '';
  let currentHwSearchRes = '';

  function formatDateStr(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
  function getDaysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
  const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

  const ganttThead = document.getElementById('gantt-thead');
  const ganttTbody = document.getElementById('gantt-tbody');
  const monthDisplay = document.getElementById('current-month-display');
  const btnPrevMonth = document.getElementById('btn-prev-month');
  const btnNextMonth = document.getElementById('btn-next-month');
  const btnToday = document.getElementById('btn-today');

  const scheduleSearchInput = document.getElementById('schedule-search-input');
  const clearScheduleSearchBtn = document.getElementById('clear-schedule-search-btn');
  const schSearchCpu = document.getElementById('sch-search-cpu');
  const schSearchGpu = document.getElementById('sch-search-gpu');
  const schSearchRam = document.getElementById('sch-search-ram');
  const schSearchRes = document.getElementById('sch-search-res');
  const btnResetHwFilters = document.getElementById('btn-reset-hw-filters');
  const scheduleCatBtns = document.querySelectorAll('#schedule-category-segmented .segment-btn');
  const ganttEmptyState = document.getElementById('gantt-empty-state');

  function renderGanttBoard() {
    if (!ganttThead || !ganttTbody) return;
    monthDisplay.textContent = `${currentBoardYear} 年 ${String(currentBoardMonth).padStart(2, '0')} 月`;
    const totalDays = getDaysInMonth(currentBoardYear, currentBoardMonth);

    let theadHtml = `
      <tr>
        <th class="th-sticky-device">
          <div class="th-device-head">
            <span class="head-title">硬件资产矩阵</span>
            <span class="head-sub">设备 / CPU / GPU / 内存同屏</span>
          </div>
        </th>
    `;

    const todayObj = new Date();
    const isCurrentRealMonth = todayObj.getFullYear() === currentBoardYear && (todayObj.getMonth() + 1) === currentBoardMonth;
    const realTodayDate = todayObj.getDate();

    for (let d = 1; d <= totalDays; d++) {
      const dateInst = new Date(currentBoardYear, currentBoardMonth - 1, d);
      const isWeekend = (dateInst.getDay() === 0 || dateInst.getDay() === 6);
      const isToday = isCurrentRealMonth && d === realTodayDate;

      theadHtml += `
        <th class="th-day-col ${isWeekend ? 'is-weekend' : ''} ${isToday ? 'is-today' : ''}">
          <div class="day-cell-header">
            <span class="day-num">${d}</span>
            <span class="day-week">周${WEEKDAY_NAMES[dateInst.getDay()]}</span>
          </div>
        </th>
      `;
    }
    theadHtml += '</tr>';
    ganttThead.innerHTML = theadHtml;

    const filteredDevices = devices.filter((dev) => {
      if (currentScheduleFilterCat !== 'all' && dev.category !== currentScheduleFilterCat) return false;
      const cpu = (dev.specs.cpu || '').toLowerCase();
      const gpu = (dev.specs.gpu || dev.specs.gpu_chip || '').toLowerCase();
      const ram = (dev.specs.ram_spec || '').toLowerCase();
      const resolution = (dev.specs.screen_res || dev.specs.resolution || '').toLowerCase();
      
      const cpuKw = currentHwSearchCpu.trim().toLowerCase();
      const gpuKw = currentHwSearchGpu.trim().toLowerCase();
      const ramKw = currentHwSearchRam.trim().toLowerCase();
      const resKw = currentHwSearchRes.trim().toLowerCase();
      const kw = currentScheduleSearchKeyword.trim().toLowerCase();

      if (cpuKw && !cpu.includes(cpuKw)) return false;
      if (gpuKw && !gpu.includes(gpuKw)) return false;
      if (ramKw && !ram.includes(ramKw)) return false;
      if (resKw && !resolution.includes(resKw)) return false;

      if (kw) {
        const fullMatch = `${dev.name} ${dev.sn} ${cpu} ${gpu} ${ram} ${resolution}`.toLowerCase().includes(kw);
        if (!fullMatch) return false;
      }
      return true;
    });

    if (filteredDevices.length === 0) {
      ganttTbody.innerHTML = '';
      if (ganttEmptyState) ganttEmptyState.style.display = 'flex';
      return;
    } else {
      if (ganttEmptyState) ganttEmptyState.style.display = 'none';
    }

    let tbodyHtml = '';
    filteredDevices.forEach((dev) => {
      const cpuChip = dev.specs.cpu || '无独立CPU';
      const gpuChip = dev.specs.gpu || dev.specs.gpu_chip || '集成/外接';
      const ramSpec = dev.specs.ram_spec || (dev.specs.gpu_vram ? `显存 ${dev.specs.gpu_vram}` : '标配内存');

      tbodyHtml += `
        <tr class="gantt-row ${dev.status === 'maintenance' ? 'row-locked-maint' : ''}">
          <td class="td-sticky-device">
            <div class="device-cell-card">
              <div class="device-cell-top">
                <span class="category-capsule">${dev.categoryName}</span>
                <strong class="device-cell-name" title="${dev.name}">${dev.name}</strong>
              </div>
              <div class="hardware-embedded-pills">
                <span class="hw-mini-pill cpu-pill" title="CPU: ${cpuChip}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" /></svg>
                  <span>${cpuChip}</span>
                </span>
                <span class="hw-mini-pill gpu-pill" title="GPU: ${gpuChip}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" /><circle cx="9" cy="9" r="2" stroke-width="2"></circle><circle cx="15" cy="15" r="2" stroke-width="2"></circle></svg>
                  <span>${gpuChip}</span>
                </span>
                <span class="hw-mini-pill ram-pill" title="内存配置: ${ramSpec}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="7" width="20" height="10" rx="2" stroke-width="2"></rect><line x1="6" y1="17" x2="6" y2="19" stroke-width="2" stroke-linecap="round"></line><line x1="10" y1="17" x2="10" y2="19" stroke-width="2" stroke-linecap="round"></line><line x1="14" y1="17" x2="14" y2="19" stroke-width="2" stroke-linecap="round"></line><line x1="18" y1="17" x2="18" y2="19" stroke-width="2" stroke-linecap="round"></line></svg>
                  <span>${ramSpec}</span>
                </span>
              </div>
            </div>
          </td>
      `;

      for (let d = 1; d <= totalDays; d++) {
        const curDateStr = formatDateStr(currentBoardYear, currentBoardMonth, d);

        if (dev.status === 'maintenance') {
          tbodyHtml += `
            <td class="td-schedule-cell cell-maintenance" data-device-id="${dev.id}" data-date="${curDateStr}" data-status="maintenance" title="【故障强锁定】${dev.faultReason || ''} · 点击穿透查看">
              <div class="cell-inner-block maint-block">
                <svg class="maint-lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke-width="2"></rect><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 11V7a5 5 0 0110 0v4"></path></svg>
              </div>
            </td>
          `;
          continue;
        }

        const matchedRes = reservations.find((r) => {
          return (r.deviceId === dev.id || r.mountedGpuId === dev.id) && curDateStr >= r.startDate && curDateStr <= r.endDate;
        });

        if (matchedRes) {
          const isMountedGpu = matchedRes.mountedGpuId === dev.id;
          tbodyHtml += `
            <td class="td-schedule-cell cell-inuse ${isMountedGpu ? 'cell-mounted-occupied' : ''}" data-device-id="${dev.id}" data-date="${curDateStr}" data-res-id="${matchedRes.id}" data-status="inuse" title="【已占用】申请人：${matchedRes.applicant}">
              <div class="cell-inner-block inuse-block">
                <span class="inuse-user">${isMountedGpu ? '外挂' : ''}${matchedRes.applicant.split(' ')[0]}</span>
                <span class="inuse-proj">${matchedRes.project}</span>
              </div>
            </td>
          `;
        } else {
          tbodyHtml += `
            <td class="td-schedule-cell cell-idle" data-device-id="${dev.id}" data-date="${curDateStr}" data-status="idle" title="${curDateStr} 空闲可用">
              <div class="cell-inner-block idle-block"><span class="idle-dot"></span></div>
            </td>
          `;
        }
      }
      tbodyHtml += '</tr>';
    });

    ganttTbody.innerHTML = tbodyHtml;
    updateBadges();
  }

  if (btnPrevMonth) btnPrevMonth.addEventListener('click', () => { currentBoardMonth--; if (currentBoardMonth < 1) { currentBoardMonth = 12; currentBoardYear--; } renderGanttBoard(); });
  if (btnNextMonth) btnNextMonth.addEventListener('click', () => { currentBoardMonth++; if (currentBoardMonth > 12) { currentBoardMonth = 1; currentBoardYear++; } renderGanttBoard(); });
  if (btnToday) btnToday.addEventListener('click', () => { const now = new Date(); currentBoardYear = now.getFullYear(); currentBoardMonth = now.getMonth() + 1; renderGanttBoard(); });
  
  if (scheduleSearchInput) scheduleSearchInput.addEventListener('input', function () { currentScheduleSearchKeyword = this.value; clearScheduleSearchBtn.style.display = currentScheduleSearchKeyword ? 'flex' : 'none'; renderGanttBoard(); });
  if (clearScheduleSearchBtn) clearScheduleSearchBtn.addEventListener('click', function () { scheduleSearchInput.value = ''; currentScheduleSearchKeyword = ''; this.style.display = 'none'; renderGanttBoard(); });
  
  if (schSearchCpu) schSearchCpu.addEventListener('input', function () { currentHwSearchCpu = this.value; renderGanttBoard(); });
  if (schSearchGpu) schSearchGpu.addEventListener('input', function () { currentHwSearchGpu = this.value; renderGanttBoard(); });
  if (schSearchRam) schSearchRam.addEventListener('input', function () { currentHwSearchRam = this.value; renderGanttBoard(); });
  if (schSearchRes) schSearchRes.addEventListener('input', function () { currentHwSearchRes = this.value; renderGanttBoard(); });
  
  if (btnResetHwFilters) btnResetHwFilters.addEventListener('click', function () {
    scheduleSearchInput.value = schSearchCpu.value = schSearchGpu.value = schSearchRam.value = schSearchRes.value = '';
    currentScheduleSearchKeyword = currentHwSearchCpu = currentHwSearchGpu = currentHwSearchRam = currentHwSearchRes = '';
    clearScheduleSearchBtn.style.display = 'none';
    renderGanttBoard();
  });
  
  scheduleCatBtns.forEach((btn) => btn.addEventListener('click', function () {
    scheduleCatBtns.forEach((b) => b.classList.remove('is-active'));
    this.classList.add('is-active');
    currentScheduleFilterCat = this.getAttribute('data-cat');
    renderGanttBoard();
  }));


  // ============================================================
  // 7. 智能快捷参数识别解析引擎 (Smart NLP/Regex Parser)
  // ============================================================
  const smartParseInput = document.getElementById('smart-parse-input');
  const btnTriggerSmartParse = document.getElementById('btn-trigger-smart-parse');
  const smartParseTags = document.getElementById('smart-parse-tags');
  const reserveRamSize = document.getElementById('reserve-ram-size');
  const reserveRamChannel = document.getElementById('reserve-ram-channel');
  const reserveOsImageRig = document.getElementById('reserve-os-image-rig');
  const reserveOsImageStd = document.getElementById('reserve-os-image-std');

  function parseSmartConfigText(rawText) {
    if (!rawText || !rawText.trim()) return null;
    const text = rawText.trim(), result = { os: null, ram: null, channel: null };
    if (/win(dows)?\s*10/i.test(text)) result.os = 'Windows 10 专业版';
    else if (/win(dows)?\s*11/i.test(text)) result.os = 'Windows 11 Pro 23H2';
    else if (/ubuntu\s*24/i.test(text)) result.os = 'Ubuntu 24.04 LTS';
    else if (/ubuntu/i.test(text)) result.os = 'Ubuntu 22.04 LTS';
    
    const ramMatch = text.match(/(\d{1,4})\s*(g|gb)\b/i);
    if (ramMatch) result.ram = `${ramMatch[1]}GB${/ddr5/i.test(text) ? ' DDR5' : ''}${/ecc/i.test(text) ? ' ECC' : ''}`;
    
    if (/单通道/i.test(text)) result.channel = '单通道 (Single)';
    else if (/双通道/i.test(text)) result.channel = '双通道 (Dual)';
    else if (/四通道/i.test(text)) result.channel = '四通道 (Quad)';
    return result;
  }

  function executeSmartParse() {
    const parsed = parseSmartConfigText(smartParseInput.value);
    if (!parsed || (!parsed.os && !parsed.ram && !parsed.channel)) {
      smartParseTags.style.display = 'none'; showToast('未匹配到有效参数', 'warning'); return;
    }
    const tagsHtml = [];
    if (parsed.ram) { reserveRamSize.value = parsed.ram; tagsHtml.push(`<span class="parsed-pill pill-ram">内存: <strong>${parsed.ram}</strong></span>`); triggerInputHighlight(reserveRamSize); }
    if (parsed.channel) { reserveRamChannel.value = parsed.channel; tagsHtml.push(`<span class="parsed-pill pill-channel">通道: <strong>${parsed.channel}</strong></span>`); triggerInputHighlight(reserveRamChannel); }
    if (parsed.os) { reserveOsImageRig.value = reserveOsImageStd.value = parsed.os; tagsHtml.push(`<span class="parsed-pill pill-os">系统: <strong>${parsed.os}</strong></span>`); triggerInputHighlight(reserveOsImageRig); triggerInputHighlight(reserveOsImageStd); }
    smartParseTags.innerHTML = tagsHtml.join('');
    smartParseTags.style.display = 'flex';
    showToast('智能提取参数成功', 'success');
  }
  function triggerInputHighlight(inputEl) { if (inputEl) { inputEl.classList.remove('is-parsed-flash'); void inputEl.offsetWidth; inputEl.classList.add('is-parsed-flash'); } }
  
  if (btnTriggerSmartParse) btnTriggerSmartParse.addEventListener('click', executeSmartParse);
  if (smartParseInput) smartParseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); executeSmartParse(); } });


  // ============================================================
  // 8. 设备预约申请表单交互与防冲突
  // ============================================================
  const reserveModalOverlay = document.getElementById('reserve-modal-overlay');
  const openReserveBtn = document.getElementById('open-reserve-btn');
  const closeReserveBtn = document.getElementById('close-reserve-btn');
  const cancelReserveBtn = document.getElementById('cancel-reserve-btn');
  const reservationForm = document.getElementById('reservation-form');
  const reserveCategoryFilter = document.getElementById('reserve-category-filter');
  const reserveDeviceSelect = document.getElementById('reserve-device-select');
  const reserveStartDate = document.getElementById('reserve-start-date');
  const reserveEndDate = document.getElementById('reserve-end-date');
  const reserveConflictBanner = document.getElementById('reserve-conflict-banner');
  const conflictAlertTitle = document.getElementById('conflict-alert-title');
  const conflictAlertDetails = document.getElementById('conflict-alert-details');
  const submitReserveBtn = document.getElementById('submit-reserve-btn');
  const dynamicAssemblyPanel = document.getElementById('dynamic-assembly-panel');
  const assemblyTypeBadge = document.getElementById('assembly-type-badge');
  const assemblyRigOptions = document.getElementById('assembly-rig-options');
  const assemblyStandardOptions = document.getElementById('assembly-standard-options');
  const reserveMountedGpu = document.getElementById('reserve-mounted-gpu');
  const reserveApplicant = document.getElementById('reserve-applicant');
  const reserveProject = document.getElementById('reserve-project');
  const reservePurpose = document.getElementById('reserve-purpose');

  const faultBlockOverlay = document.getElementById('fault-block-overlay');
  const faultBlockDevName = document.getElementById('fault-block-dev-name');
  const faultBlockReasonText = document.getElementById('fault-block-reason-text');
  const closeFaultBlockBtn = document.getElementById('close-fault-block-btn');
  const gotoFaultTicketBtn = document.getElementById('goto-fault-ticket-btn');

  const assemblyReceiptOverlay = document.getElementById('assembly-receipt-overlay');
  const closeReceiptBtn = document.getElementById('close-receipt-btn');
  const receiptSerialNo = document.getElementById('receipt-serial-no');
  const receiptDevName = document.getElementById('receipt-dev-name');
  const receiptDevCat = document.getElementById('receipt-dev-cat');
  const receiptDateRange = document.getElementById('receipt-date-range');
  const receiptApplicantProject = document.getElementById('receipt-applicant-project');
  const receiptSpecList = document.getElementById('receipt-spec-list');
  const btnStaySchedule = document.getElementById('btn-stay-schedule');
  const btnGotoLoanView = document.getElementById('btn-goto-loan-view');

  function populateFreeCabinetGpus(preselectGpuId = 'none') {
    if(!reserveMountedGpu) return;
    reserveMountedGpu.innerHTML = '<option value="none">不额外挂载 (使用节点原有配置)</option>';
    devices.filter(d => d.category === 'gpu' && d.status !== 'retired').forEach(gpu => {
      const opt = document.createElement('option');
      opt.value = gpu.id;
      opt.textContent = `${gpu.name} · ${gpu.location}`;
      if (gpu.status === 'maintenance') { opt.textContent += ' [故障锁定]'; opt.disabled = true; }
      if (gpu.id === preselectGpuId) opt.selected = true;
      reserveMountedGpu.appendChild(opt);
    });
  }

  function updateReserveDeviceDropdown(catFilter = 'all', preselectDeviceId = '') {
    if(!reserveDeviceSelect) return;
    reserveDeviceSelect.innerHTML = '';
    const activeDevices = devices.filter(d => d.status !== 'retired' && (catFilter === 'all' || d.category === catFilter));
    if (activeDevices.length === 0) {
      reserveDeviceSelect.innerHTML = '<option value="">当前分类暂无可预约设备</option>';
      updateDynamicAssemblySubform();
      validateConflictsAndFaults();
      return;
    }
    activeDevices.forEach((dev) => {
      const opt = document.createElement('option');
      opt.value = dev.id;
      opt.textContent = `[${dev.categoryName}] ${dev.name}`;
      if (dev.status === 'maintenance') opt.textContent += ' (⚠️ 处于故障期)';
      if (dev.id === preselectDeviceId) opt.selected = true;
      reserveDeviceSelect.appendChild(opt);
    });
    updateDynamicAssemblySubform();
    validateConflictsAndFaults();
  }

  function updateDynamicAssemblySubform() {
    if(!reserveDeviceSelect || !dynamicAssemblyPanel) return;
    const devId = reserveDeviceSelect.value;
    const dev = devices.find((d) => d.id === devId);
    if (!dev) { dynamicAssemblyPanel.style.display = 'none'; return; }
    if (dev.category === 'custom-rig') {
      dynamicAssemblyPanel.style.display = 'flex';
      if(assemblyTypeBadge) assemblyTypeBadge.textContent = '组装节点智能装机';
      if(assemblyRigOptions) assemblyRigOptions.style.display = 'block';
      if(assemblyStandardOptions) assemblyStandardOptions.style.display = 'none';
      populateFreeCabinetGpus(reserveMountedGpu ? reserveMountedGpu.value : 'none');
    } else if (dev.category === 'laptop' || dev.category === 'desktop') {
      dynamicAssemblyPanel.style.display = 'flex';
      if(assemblyTypeBadge) assemblyTypeBadge.textContent = '整机系统镜像配置';
      if(assemblyRigOptions) assemblyRigOptions.style.display = 'none';
      if(assemblyStandardOptions) assemblyStandardOptions.style.display = 'block';
    } else {
      dynamicAssemblyPanel.style.display = 'none';
    }
  }

  function validateConflictsAndFaults() {
    if(!reserveDeviceSelect) return true;
    const devId = reserveDeviceSelect.value;
    const sDate = reserveStartDate ? reserveStartDate.value : null;
    const eDate = reserveEndDate ? reserveEndDate.value : null;
    const mountedGpuVal = reserveMountedGpu ? reserveMountedGpu.value : 'none';
    
    if (!devId) { 
      if(reserveConflictBanner) reserveConflictBanner.style.display = 'none'; 
      if(submitReserveBtn) submitReserveBtn.disabled = false; 
      return true; 
    }

    const targetDev = devices.find((d) => d.id === devId);
    if (!targetDev) return true;

    if (targetDev.status === 'maintenance') { triggerFaultHardInterception(targetDev); return false; }
    if (targetDev.category === 'custom-rig' && mountedGpuVal && mountedGpuVal !== 'none') {
      const mountedGpuDev = devices.find((d) => d.id === mountedGpuVal);
      if (mountedGpuDev && mountedGpuDev.status === 'maintenance') { triggerFaultHardInterception(mountedGpuDev); return false; }
    }

    if (!sDate || !eDate || sDate > eDate) return true;

    const hostConflict = reservations.find(r => (r.deviceId === devId || r.mountedGpuId === devId) && !(eDate < r.startDate || sDate > r.endDate));
    let gpuConflict = null;
    if (targetDev.category === 'custom-rig' && mountedGpuVal && mountedGpuVal !== 'none') {
      gpuConflict = reservations.find(r => (r.deviceId === mountedGpuVal || r.mountedGpuId === mountedGpuVal) && !(eDate < r.startDate || sDate > r.endDate));
    }

    if (hostConflict || gpuConflict) {
      if(reserveConflictBanner) reserveConflictBanner.style.display = 'flex';
      if(submitReserveBtn) submitReserveBtn.disabled = true;
      if (hostConflict) {
        if(conflictAlertTitle) conflictAlertTitle.textContent = '检测到目标主机排期冲突：系统已执行提交拦截';
        if(conflictAlertDetails) conflictAlertDetails.innerHTML = `设备 <strong>[${targetDev.name}]</strong> 在该时段已被占用。`;
      } else if (gpuConflict) {
        if(conflictAlertTitle) conflictAlertTitle.textContent = '检测到外挂显卡 (GPU) 排期冲突：系统已执行提交拦截';
        if(conflictAlertDetails) conflictAlertDetails.innerHTML = `外挂显卡在该时段已被占用。`;
      }
      return false;
    }
    if(reserveConflictBanner) reserveConflictBanner.style.display = 'none';
    if(submitReserveBtn) submitReserveBtn.disabled = false;
    return true;
  }

  function triggerFaultHardInterception(faultDev) {
    if(submitReserveBtn) submitReserveBtn.disabled = true;
    if(faultBlockDevName) faultBlockDevName.textContent = faultDev.name;
    if(faultBlockReasonText) faultBlockReasonText.textContent = faultDev.faultReason || '设备处于硬件电气维保锁定阶段。';
    if(faultBlockOverlay) faultBlockOverlay.classList.add('is-active');
  }

  if (closeFaultBlockBtn) closeFaultBlockBtn.addEventListener('click', () => faultBlockOverlay.classList.remove('is-active'));
  if (gotoFaultTicketBtn) gotoFaultTicketBtn.addEventListener('click', () => { faultBlockOverlay.classList.remove('is-active'); reserveModalOverlay.classList.remove('is-active'); showToast(`已转入报修系统`, 'warning'); });
  
  if (reserveCategoryFilter) reserveCategoryFilter.addEventListener('change', function () { updateReserveDeviceDropdown(this.value); });
  if (reserveDeviceSelect) reserveDeviceSelect.addEventListener('change', () => { updateDynamicAssemblySubform(); validateConflictsAndFaults(); });
  if (reserveStartDate) reserveStartDate.addEventListener('input', validateConflictsAndFaults);
  if (reserveEndDate) reserveEndDate.addEventListener('input', validateConflictsAndFaults);
  if (reserveMountedGpu) reserveMountedGpu.addEventListener('change', validateConflictsAndFaults);

  function openReservationModal(preselectDeviceId = '', preselectDate = '') {
    const dev = devices.find((d) => d.id === preselectDeviceId);
    if(reserveCategoryFilter) reserveCategoryFilter.value = dev ? dev.category : 'all';
    updateReserveDeviceDropdown(reserveCategoryFilter ? reserveCategoryFilter.value : 'all', preselectDeviceId);
    const defaultDate = preselectDate || formatDateStr(currentBoardYear, currentBoardMonth, 1);
    if(reserveStartDate) reserveStartDate.value = defaultDate;
    if(reserveEndDate) reserveEndDate.value = defaultDate;
    if(smartParseInput) smartParseInput.value = ''; 
    if(smartParseTags) smartParseTags.style.display = 'none';
    validateConflictsAndFaults();
    if(reserveModalOverlay) reserveModalOverlay.classList.add('is-active');
  }

  if (openReserveBtn) openReserveBtn.addEventListener('click', () => openReservationModal());
  if (closeReserveBtn) closeReserveBtn.addEventListener('click', () => reserveModalOverlay.classList.remove('is-active'));
  if (cancelReserveBtn) cancelReserveBtn.addEventListener('click', () => reserveModalOverlay.classList.remove('is-active'));

  if (reservationForm) {
    reservationForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!validateConflictsAndFaults()) return;

      const devId = reserveDeviceSelect.value;
      const targetDev = devices.find((d) => d.id === devId);
      if (!targetDev) return;

      const serialNo = `WO-ASM-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
      const customAssembly = {};
      const receiptSpecs = [];

      if (targetDev.category === 'custom-rig') {
        const mountedGpuVal = reserveMountedGpu.value;
        if (mountedGpuVal && mountedGpuVal !== 'none') {
          const gpuDev = devices.find((d) => d.id === mountedGpuVal);
          customAssembly.mountedGpu = gpuDev ? gpuDev.name : mountedGpuVal;
          customAssembly.mountedGpuId = mountedGpuVal;
          receiptSpecs.push(`【外挂算力】挂载显卡：<strong>${customAssembly.mountedGpu}</strong>`);
        } else { receiptSpecs.push(`【外挂算力】不挂载`); }
        customAssembly.ramSize = reserveRamSize.value.trim();
        customAssembly.ramChannel = reserveRamChannel.value.trim();
        customAssembly.osImage = reserveOsImageRig.value.trim();
        receiptSpecs.push(`【内存调优】指定容量：<strong>${customAssembly.ramSize}</strong>`);
        receiptSpecs.push(`【镜像部署】定制镜像：<strong>${customAssembly.osImage}</strong>`);
      } else if (targetDev.category === 'laptop' || targetDev.category === 'desktop') {
        customAssembly.osImage = reserveOsImageStd.value.trim();
        receiptSpecs.push(`【整机系统】定制安装：<strong>${customAssembly.osImage}</strong>`);
      } else {
        receiptSpecs.push(`【直接领用】标准出库`);
      }

      const newReservation = {
        id: `RES-${Date.now().toString().slice(-4)}`,
        deviceId: devId,
        mountedGpuId: customAssembly.mountedGpuId || null,
        startDate: reserveStartDate.value,
        endDate: reserveEndDate.value,
        applicant: reserveApplicant.value.trim(),
        project: reserveProject.value.trim(),
        purpose: reservePurpose.value.trim(),
        serialNo,
        customAssembly
      };

      try {
        await fetchAPI('/reservations', {
          method: 'POST',
          body: JSON.stringify(newReservation)
        });
      } catch(err) { console.warn('API同步失败，转为本地保存', err); }

      reservations.push(newReservation);
      targetDev.status = 'inuse';
      if (customAssembly.mountedGpuId) {
        const gpuDev = devices.find((d) => d.id === customAssembly.mountedGpuId);
        if (gpuDev) gpuDev.status = 'inuse';
      }

      reserveModalOverlay.classList.remove('is-active');
      reservationForm.reset();
      if(receiptSerialNo) receiptSerialNo.textContent = serialNo;
      if(receiptDevName) receiptDevName.textContent = targetDev.name;
      if(receiptDevCat) receiptDevCat.textContent = targetDev.categoryName;
      if(receiptDateRange) receiptDateRange.textContent = `${newReservation.startDate} 至 ${newReservation.endDate}`;
      if(receiptApplicantProject) receiptApplicantProject.textContent = `${newReservation.applicant} / ${newReservation.project}`;
      if(receiptSpecList) receiptSpecList.innerHTML = receiptSpecs.map(item => `<li>${item}</li>`).join('');
      if(assemblyReceiptOverlay) assemblyReceiptOverlay.classList.add('is-active');
      
      renderGanttBoard(); renderCards();
      showToast(`排期锁定完成，装机作业流水号 [${serialNo}] 已生成`, 'success');
    });
  }

  if (closeReceiptBtn) closeReceiptBtn.addEventListener('click', () => assemblyReceiptOverlay.classList.remove('is-active'));
  if (btnStaySchedule) btnStaySchedule.addEventListener('click', () => assemblyReceiptOverlay.classList.remove('is-active'));
  if (btnGotoLoanView) btnGotoLoanView.addEventListener('click', () => { assemblyReceiptOverlay.classList.remove('is-active'); document.getElementById('nav-loan').click(); });


  // ============================================================
  // 9. 单元格穿透与单日态势弹窗
  // ============================================================
  const cellDossierOverlay = document.getElementById('cell-dossier-overlay');
  const closeCellDossierBtn = document.getElementById('close-cell-dossier-btn');
  const closeCellBtnAction = document.getElementById('close-cell-btn-action');
  const cellDossierBadge = document.getElementById('cell-dossier-badge');
  const cellDossierDeviceName = document.getElementById('cell-dossier-device-name');
  const cellDossierDateText = document.getElementById('cell-dossier-date-text');
  const cellDossierCategory = document.getElementById('cell-dossier-category');
  const cellDossierSn = document.getElementById('cell-dossier-sn');
  const cellStatusBanner = document.getElementById('cell-status-banner');
  const bannerIconDot = document.getElementById('banner-icon-dot');
  const bannerStatusTitle = document.getElementById('banner-status-title');
  const bannerStatusDetails = document.getElementById('banner-status-details');
  const cellDossierHardwareGroups = document.getElementById('cell-dossier-hardware-groups');
  const cellModalActions = document.getElementById('cell-modal-actions');

  function openCellDossier(deviceId, dateStr, status, resId = null) {
    const dev = devices.find((d) => d.id === deviceId);
    if (!dev) return;
    if(cellDossierDeviceName) cellDossierDeviceName.textContent = dev.name;
    if(cellDossierDateText) cellDossierDateText.textContent = dateStr;
    if(cellDossierCategory) cellDossierCategory.textContent = dev.categoryName;
    if(cellDossierSn) cellDossierSn.textContent = dev.sn;
    
    if (status === 'idle') {
      if(cellDossierBadge) { cellDossierBadge.textContent = '空闲可预约'; cellDossierBadge.className = 'dossier-top-badge status-idle'; }
      if(cellStatusBanner) cellStatusBanner.className = 'cell-status-banner banner-idle'; 
      if(bannerIconDot) bannerIconDot.className = 'banner-icon-dot dot-idle';
      if(bannerStatusTitle) bannerStatusTitle.textContent = `${dateStr} · 设备当前空闲可用`;
      if(bannerStatusDetails) bannerStatusDetails.textContent = '此设备在所选日期无占用排期。可直接发起定制装机申请。';
      if(cellModalActions) cellModalActions.innerHTML = `<button type="button" class="glass-btn btn-primary" id="btn-quick-reserve">一键填入预约</button>`;
      setTimeout(() => { const btn = document.getElementById('btn-quick-reserve'); if(btn) btn.addEventListener('click', () => { cellDossierOverlay.classList.remove('is-active'); openReservationModal(dev.id, dateStr); }); }, 0);
    } else if (status === 'inuse') {
      const res = reservations.find((r) => r.id === resId);
      if(cellDossierBadge) { cellDossierBadge.textContent = '已排期占用'; cellDossierBadge.className = 'dossier-top-badge status-inuse'; }
      if(cellStatusBanner) cellStatusBanner.className = 'cell-status-banner banner-inuse'; 
      if(bannerIconDot) bannerIconDot.className = 'banner-icon-dot dot-inuse';
      if(bannerStatusTitle) bannerStatusTitle.textContent = `${dateStr} · 研发任务占用中`;
      if(bannerStatusDetails) bannerStatusDetails.innerHTML = `<strong>申请人：</strong>${res ? res.applicant : '工程师'}<br/><strong>所属项目：</strong>${res ? res.project : '未指派'}`;
      if(cellModalActions) cellModalActions.innerHTML = `<button type="button" class="glass-btn btn-secondary" disabled>时段已被占用</button>`;
    } else if (status === 'maintenance') {
      if(cellDossierBadge) { cellDossierBadge.textContent = '故障维护强锁定'; cellDossierBadge.className = 'dossier-top-badge status-maintenance pulse-alert'; }
      if(cellStatusBanner) cellStatusBanner.className = 'cell-status-banner banner-maint'; 
      if(bannerIconDot) bannerIconDot.className = 'banner-icon-dot dot-maint';
      if(bannerStatusTitle) bannerStatusTitle.textContent = `${dateStr} · 硬件故障维护中`;
      if(bannerStatusDetails) bannerStatusDetails.innerHTML = `<strong>锁止原因：</strong>${dev.faultReason || '处于维保锁定阶段'}`;
      if(cellModalActions) cellModalActions.innerHTML = `<button type="button" class="glass-btn btn-danger" id="btn-jump-ticket">查看报修工单</button>`;
      setTimeout(() => { const btn = document.getElementById('btn-jump-ticket'); if(btn) btn.addEventListener('click', () => showToast(`联动报修单`, 'error')); }, 0);
    }

    if (cellDossierHardwareGroups) {
      cellDossierHardwareGroups.innerHTML = '';
      const schema = HARDWARE_SCHEMAS[dev.category];
      if (schema) {
        schema.groups.forEach((grp) => {
          const grpWrap = document.createElement('div'); grpWrap.className = 'dossier-subsystem-block';
          let html = `<div class="dossier-subsystem-head"><span class="subsystem-dot"></span><h4 class="subsystem-title">${grp.groupTitle}</h4></div><div class="specs-matrix">`;
          grp.fields.forEach((f) => { html += `<div class="matrix-row"><span class="matrix-key">${f.label}</span><span class="matrix-value">${dev.specs[f.key] || '—'}</span></div>`; });
          html += '</div>'; grpWrap.innerHTML = html; cellDossierHardwareGroups.appendChild(grpWrap);
        });
      }
    }
    if (cellDossierOverlay) cellDossierOverlay.classList.add('is-active');
  }

  if (closeCellDossierBtn) closeCellDossierBtn.addEventListener('click', () => cellDossierOverlay.classList.remove('is-active'));
  if (closeCellBtnAction) closeCellBtnAction.addEventListener('click', () => cellDossierOverlay.classList.remove('is-active'));
  if (ganttTbody) ganttTbody.addEventListener('click', (e) => {
    const cell = e.target.closest('.td-schedule-cell');
    if (!cell) return;
    openCellDossier(cell.getAttribute('data-device-id'), cell.getAttribute('data-date'), cell.getAttribute('data-status'), cell.getAttribute('data-res-id'));
  });


  // ============================================================
  // 10. 设备管理主视图逻辑 (完全恢复的完整版)
  // ============================================================
  let currentDevFilterCategory = 'all';
  let currentDevSearchQuery = '';
  let currentDevSearchScope = 'all';

  const cardsGrid = document.getElementById('cards-grid');
  const assetCount = document.getElementById('asset-count');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const searchScopeSelect = document.getElementById('search-scope-select');
  const clearSearchBtn = document.getElementById('clear-search-btn');
  const categorySegments = document.querySelectorAll('#category-segmented .segment-btn');

  function generateHardwareSummary(dev) {
    const s = dev.specs || {};
    const pills = [];
    if (s.cpu) pills.push(s.cpu);
    if (s.gpu) pills.push(s.gpu);
    if (s.ram_spec) pills.push(s.ram_spec);
    if (s.screen_res) pills.push(s.screen_res.split(' ')[0]);
    return pills.slice(0, 4);
  }

  function getStatusBadgeConfig(status) {
    switch (status) {
      case 'idle': return { label: '空闲可用', class: 'status-idle' };
      case 'inuse': return { label: '已排期占用', class: 'status-inuse' };
      case 'maintenance': return { label: '故障维护中', class: 'status-maintenance pulse-alert' };
      case 'retired': return { label: '已退库', class: 'status-retired' };
      default: return { label: '未知状态', class: 'status-retired' };
    }
  }

  function renderCards() {
    if (!cardsGrid) return;
    const q = currentDevSearchQuery.trim().toLowerCase();
    const scope = currentDevSearchScope;
    
    const filtered = devices.filter((d) => {
      if (currentDevFilterCategory === 'retired') { if (d.status !== 'retired') return false; }
      else if (currentDevFilterCategory !== 'all') { if (d.category !== currentDevFilterCategory) return false; }
      
      if (!q) return true;
      if (scope === 'name') return `${d.id} ${d.name}`.toLowerCase().includes(q);
      if (scope === 'sn') return `${d.sn}`.toLowerCase().includes(q);
      if (scope === 'location') return `${d.location}`.toLowerCase().includes(q);
      if (scope === 'hardware') {
        const specsStr = Object.values(d.specs || {}).join(' ').toLowerCase();
        return specsStr.includes(q);
      }
      if (scope === 'operator') {
        return `${d.creator || ''} ${d.updatedBy || ''}`.toLowerCase().includes(q);
      }
      const specsStr = Object.values(d.specs || {}).join(' ').toLowerCase();
      const searchable = `${d.id} ${d.name} ${d.categoryName} ${d.location} ${d.sn} ${d.creator || ''} ${d.updatedBy || ''} ${specsStr}`.toLowerCase();
      return searchable.includes(q);
    });

    if (assetCount) assetCount.textContent = filtered.length;
    cardsGrid.innerHTML = '';
    
    if (filtered.length === 0) { 
      if (emptyState) emptyState.style.display = 'flex'; 
    } else {
      if (emptyState) emptyState.style.display = 'none';
      filtered.forEach((dev) => {
        const statusCfg = getStatusBadgeConfig(dev.status);
        const summaryTags = generateHardwareSummary(dev);
        const updateInfoText = dev.updatedAt ? `${dev.updatedAt.split(' ')[0]} · ${dev.updatedBy || '经办人'}` : '尚未修改';

        const card = document.createElement('article');
        card.className = `asset-glass-card ${dev.status === 'maintenance' ? 'is-fault-card' : ''}`;
        card.innerHTML = `
          <div class="card-head-row">
            <div class="card-title-group">
              <span class="card-category-tag">${dev.categoryName}</span>
              <h3 class="card-name">${dev.name}</h3>
            </div>
            <span class="status-pill ${statusCfg.class}">${statusCfg.label}</span>
          </div>

          <div class="card-meta-list">
            <div class="card-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
              <span>机位: <strong>${dev.location}</strong></span>
            </div>
            <div class="card-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>
              <span>SN: <code>${dev.sn}</code></span>
            </div>
            <div class="card-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              <span>入库: ${dev.createdAt.split(' ')[0]}</span>
            </div>
            <div class="card-meta-item ${dev.updatedAt ? 'has-update' : 'no-update'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              <span>修改: ${updateInfoText}</span>
            </div>
          </div>

          <div class="card-specs-preview">
            ${summaryTags.map((t) => `<span class="spec-pill" title="${t}">${t}</span>`).join('')}
          </div>

          <div class="card-action-bar">
            <button type="button" class="card-action-btn primary-action" data-action="dossier" data-id="${dev.id}">全维档案</button>
            <button type="button" class="card-action-btn" data-action="edit" data-id="${dev.id}">编辑</button>
            ${
              dev.status === 'maintenance'
                ? `<button type="button" class="card-action-btn fault-warn-btn" data-action="fault-jump" data-id="${dev.id}">
                     <span class="pulsing-mini-dot"></span>故障联动
                   </button>`
                : `<button type="button" class="card-action-btn" data-action="quick-retire" data-id="${dev.id}">退库</button>`
            }
          </div>
        `;
        cardsGrid.appendChild(card);
      });
    }
    updateBadges();
  }

  if (searchScopeSelect) searchScopeSelect.addEventListener('change', function () { currentDevSearchScope = this.value; renderCards(); });
  categorySegments.forEach((btn) => {
    btn.addEventListener('click', function () {
      categorySegments.forEach((s) => s.classList.remove('is-active'));
      this.classList.add('is-active'); currentDevFilterCategory = this.getAttribute('data-cat'); renderCards();
    });
  });
  if (searchInput) searchInput.addEventListener('input', function () { currentDevSearchQuery = this.value; if(clearSearchBtn) clearSearchBtn.style.display = currentDevSearchQuery ? 'flex' : 'none'; renderCards(); });
  if (clearSearchBtn) clearSearchBtn.addEventListener('click', function () { if(searchInput) searchInput.value = ''; currentDevSearchQuery = ''; this.style.display = 'none'; renderCards(); });


  // ============================================================
  // 11. 设备录入/编辑与全维档案/退库
  // ============================================================
  const formModalOverlay = document.getElementById('form-modal-overlay');
  const formCategorySelect = document.getElementById('form-category-select');
  const dynamicSpecsWrapper = document.getElementById('dynamic-specs-wrapper');
  const openCreateBtn = document.getElementById('open-create-btn');
  const closeFormBtn = document.getElementById('close-form-btn');
  const cancelFormBtn = document.getElementById('cancel-form-btn');
  const deviceEntryForm = document.getElementById('device-entry-form');
  const formDeviceName = document.getElementById('form-device-name');
  const formDeviceSn = document.getElementById('form-device-sn');
  const formDeviceLocation = document.getElementById('form-device-location');
  const formBaselineTime = document.getElementById('form-baseline-time');
  const formAuditUpdateInfo = document.getElementById('form-audit-update-info');
  const entryDeviceId = document.getElementById('entry-device-id');
  const formModalTitle = document.getElementById('form-modal-title');
  const modalBadgeMode = document.getElementById('modal-badge-mode');

  function renderDynamicGroupedFields(categoryKey, prefilledSpecs = {}) {
    const schema = HARDWARE_SCHEMAS[categoryKey];
    if (!schema || !dynamicSpecsWrapper) return;
    dynamicSpecsWrapper.innerHTML = '';
    schema.groups.forEach((grp) => {
      const groupCard = document.createElement('div'); groupCard.className = 'form-section-panel';
      let fieldsHtml = `<div class="panel-section-title"><span>${grp.groupTitle}</span></div><div class="form-grouped-grid">`;
      grp.fields.forEach((f) => {
        const val = prefilledSpecs[f.key] || '';
        let inputElement = f.type === 'select' 
          ? `<select name="spec_${f.key}" class="form-select">${f.options.map(opt => `<option value="${opt}" ${val === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>`
          : `<input type="text" name="spec_${f.key}" class="form-input" placeholder="${f.placeholder}" value="${val}" ${f.required ? 'required' : ''} />`;
        fieldsHtml += `<div class="form-group ${f.width === 'full' ? 'grid-col-full' : 'grid-col-half'}"><label class="form-label">${f.label} ${f.required?'<span class="required-star">*</span>':''}</label>${inputElement}</div>`;
      });
      fieldsHtml += '</div>'; groupCard.innerHTML = fieldsHtml; dynamicSpecsWrapper.appendChild(groupCard);
    });
  }

  if (formCategorySelect) formCategorySelect.addEventListener('change', function () { renderDynamicGroupedFields(this.value); });

  function openFormModal(editingDevice = null) {
    if (editingDevice) {
      if(modalBadgeMode) modalBadgeMode.textContent = 'UPDATE AUDIT';
      if(formModalTitle) formModalTitle.textContent = `修改设备规格 · ${editingDevice.name}`;
      if(entryDeviceId) entryDeviceId.value = editingDevice.id;
      if(formCategorySelect) { formCategorySelect.value = editingDevice.category; formCategorySelect.disabled = true; }
      if(formDeviceName) formDeviceName.value = editingDevice.name; 
      if(formDeviceSn) formDeviceSn.value = editingDevice.sn; 
      if(formDeviceLocation) formDeviceLocation.value = editingDevice.location;
      if(formBaselineTime) formBaselineTime.value = `${editingDevice.createdAt} (锁定)`;
      if(formAuditUpdateInfo) formAuditUpdateInfo.value = editingDevice.updatedAt ? `${editingDevice.updatedAt}` : '尚无修改记录';
      renderDynamicGroupedFields(editingDevice.category, editingDevice.specs);
    } else {
      if(modalBadgeMode) modalBadgeMode.textContent = 'NEW ASSET ENTRY';
      if(formModalTitle) formModalTitle.textContent = '设备录入与规格建档';
      if(entryDeviceId) entryDeviceId.value = ''; 
      if(formCategorySelect) { formCategorySelect.disabled = false; formCategorySelect.value = 'custom-rig'; }
      if(deviceEntryForm) deviceEntryForm.reset(); 
      if(formBaselineTime) formBaselineTime.value = `录入自动锁定`;
      if(formAuditUpdateInfo) formAuditUpdateInfo.value = '新建入库暂无修改历史';
      renderDynamicGroupedFields('custom-rig');
    }
    if(formModalOverlay) formModalOverlay.classList.add('is-active');
  }

  if (openCreateBtn) openCreateBtn.addEventListener('click', () => openFormModal(null));
  if (closeFormBtn) closeFormBtn.addEventListener('click', () => formModalOverlay.classList.remove('is-active'));
  if (cancelFormBtn) cancelFormBtn.addEventListener('click', () => formModalOverlay.classList.remove('is-active'));

  if (deviceEntryForm) {
    deviceEntryForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      const editingId = entryDeviceId.value;
      const categoryKey = formCategorySelect.value;
      const specsObj = {};
      HARDWARE_SCHEMAS[categoryKey].groups.forEach((grp) => { grp.fields.forEach((f) => { const input = deviceEntryForm.querySelector(`[name="spec_${f.key}"]`); if (input) specsObj[f.key] = input.value.trim(); }); });
      const nowTimestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

      if (editingId) {
        const target = devices.find((d) => d.id === editingId);
        if (target) {
          target.name = formDeviceName.value.trim(); target.sn = formDeviceSn.value.trim(); target.location = formDeviceLocation.value.trim(); target.specs = specsObj; target.updatedAt = nowTimestamp; target.updatedBy = document.getElementById('global-user-name').textContent || 'Admin';
          try { await fetchAPI(`/devices/${editingId}`, { method: 'PUT', body: JSON.stringify(target) }); } catch(e){}
          showToast(`修改成功`);
        }
      } else {
        const newDevice = {
          id: `DEV-${Date.now().toString().slice(-4)}`, name: formDeviceName.value.trim(), category: categoryKey, categoryName: HARDWARE_SCHEMAS[categoryKey].name, status: 'idle', location: formDeviceLocation.value.trim(), sn: formDeviceSn.value.trim(), createdAt: nowTimestamp, creator: document.getElementById('global-user-name').textContent || 'Admin', updatedAt: null, updatedBy: null, specs: specsObj
        };
        devices.unshift(newDevice);
        try { await fetchAPI(`/devices`, { method: 'POST', body: JSON.stringify(newDevice) }); } catch(e){}
        showToast(`录入成功`);
      }
      formModalOverlay.classList.remove('is-active'); renderCards(); renderGanttBoard();
    });
  }

  const dossierModalOverlay = document.getElementById('dossier-modal-overlay');
  const closeDossierBtn = document.getElementById('close-dossier-btn');
  const dossierTitle = document.getElementById('dossier-title');
  const dossierCategory = document.getElementById('dossier-category');
  const dossierLocation = document.getElementById('dossier-location');
  const dossierSn = document.getElementById('dossier-sn');
  const dossierGroupsContainer = document.getElementById('dossier-groups-container');
  const dossierEditBtn = document.getElementById('dossier-edit-btn');
  const dossierBaselineTime = document.getElementById('dossier-baseline-time');
  const dossierCreator = document.getElementById('dossier-creator');
  const dossierUpdateNode = document.getElementById('dossier-update-node');
  const dossierUpdateTime = document.getElementById('dossier-update-time');
  const dossierUpdater = document.getElementById('dossier-updater');
  let currentActiveDossierDevice = null;

  function openDossierModal(dev) {
    currentActiveDossierDevice = dev;
    if(dossierTitle) dossierTitle.textContent = dev.name; 
    if(dossierCategory) dossierCategory.textContent = dev.categoryName; 
    if(dossierLocation) dossierLocation.textContent = dev.location; 
    if(dossierSn) dossierSn.textContent = dev.sn;
    
    if(dossierBaselineTime) dossierBaselineTime.textContent = dev.createdAt;
    if(dossierCreator) dossierCreator.textContent = dev.creator;
    if(dev.updatedAt) {
      if(dossierUpdateNode) dossierUpdateNode.style.display = 'flex';
      if(dossierUpdateTime) dossierUpdateTime.textContent = dev.updatedAt;
      if(dossierUpdater) dossierUpdater.textContent = dev.updatedBy || '管理员';
    } else {
      if(dossierUpdateNode) dossierUpdateNode.style.display = 'none';
    }

    if (dossierGroupsContainer) {
      dossierGroupsContainer.innerHTML = '';
      const schema = HARDWARE_SCHEMAS[dev.category];
      if (schema) {
        schema.groups.forEach((grp) => {
          const grpWrap = document.createElement('div'); grpWrap.className = 'dossier-subsystem-block';
          let html = `<div class="dossier-subsystem-head"><span class="subsystem-dot"></span><h4 class="subsystem-title">${grp.groupTitle}</h4></div><div class="specs-matrix">`;
          grp.fields.forEach((f) => { html += `<div class="matrix-row"><span class="matrix-key">${f.label}</span><span class="matrix-value">${dev.specs[f.key] || '—'}</span></div>`; });
          html += '</div>'; grpWrap.innerHTML = html; dossierGroupsContainer.appendChild(grpWrap);
        });
      }
    }
    if (dossierModalOverlay) dossierModalOverlay.classList.add('is-active');
  }

  if (closeDossierBtn) closeDossierBtn.addEventListener('click', () => dossierModalOverlay.classList.remove('is-active'));
  if (dossierEditBtn) dossierEditBtn.addEventListener('click', () => { if (currentActiveDossierDevice) { dossierModalOverlay.classList.remove('is-active'); openFormModal(currentActiveDossierDevice); }});

  const retireModalOverlay = document.getElementById('retire-modal-overlay');
  const cancelRetireBtn = document.getElementById('cancel-retire-btn');
  const confirmRetireBtn = document.getElementById('confirm-retire-btn');
  let currentRetireTargetDevice = null;

  function openRetireModal(dev) {
    currentRetireTargetDevice = dev;
    document.getElementById('retire-target-name').textContent = dev.name;
    if(retireModalOverlay) retireModalOverlay.classList.add('is-active');
  }

  if (cancelRetireBtn) cancelRetireBtn.addEventListener('click', () => retireModalOverlay.classList.remove('is-active'));
  if (confirmRetireBtn) {
    confirmRetireBtn.addEventListener('click', async () => {
      if (!currentRetireTargetDevice) return;
      currentRetireTargetDevice.status = 'retired'; currentRetireTargetDevice.location = '退库归档'; currentRetireTargetDevice.updatedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);
      try { await fetchAPI(`/devices/${currentRetireTargetDevice.id}`, { method: 'PUT', body: JSON.stringify(currentRetireTargetDevice) }); } catch(e){}
      showToast(`设备退库已完成`);
      retireModalOverlay.classList.remove('is-active'); renderCards(); renderGanttBoard();
    });
  }

  if (cardsGrid) {
    cardsGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const dev = devices.find((item) => item.id === btn.getAttribute('data-id'));
      if (!dev) return;
      if (action === 'dossier') openDossierModal(dev);
      else if (action === 'edit') openFormModal(dev);
      else if (action === 'quick-retire') openRetireModal(dev);
      else if (action === 'fault-jump') showToast(`【故障锁定】专员处理中`, 'error');
    });
  }

  // ============================================================
  // 12. 系统初始化与数据拉取
  // ============================================================
  fetchBackendData();

});