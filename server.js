const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'liquid-glass-super-secret-key-2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/'))); 

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1', // 保持同机连接最稳定
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '2001629ylt',
  database: process.env.DB_NAME || 'lbbccz',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const pool = mysql.createPool(dbConfig);

// =========================================================
// 统一日志服务 (Logger Service) - 绝不阻断业务
// =========================================================
const logger = {
  // 脱敏处理，防止密码/Token等敏感信息写入数据库
  sanitize(data) {
    if (!data) return null;
    if (typeof data !== 'object') return data;
    const result = Array.isArray(data) ? [] : {};
    for (const key in data) {
      if (['password', 'oldpassword', 'newpassword', 'token', 'authorization'].includes(key.toLowerCase())) {
        result[key] = '******';
      } else if (typeof data[key] === 'object') {
        result[key] = this.sanitize(data[key]);
      } else {
        result[key] = data[key];
      }
    }
    return result;
  },

  // 1. 操作日志 (Audit Log)
  async audit(userId, username, action, module, target, oldData, newData, req, resultStat, errorMsg = null) {
    try {
      const ip = req ? (req.headers['x-forwarded-for'] || req.ip) : 'unknown';
      const ua = req ? req.headers['user-agent'] : 'unknown';
      await pool.query(
        `INSERT INTO audit_logs (user_id, username, action_type, module, target, old_data, new_data, ip, user_agent, result, error_msg, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [userId, username, action, module, target, JSON.stringify(this.sanitize(oldData)), JSON.stringify(this.sanitize(newData)), ip, ua, resultStat, errorMsg]
      );
    } catch (e) { console.error('写入操作日志失败:', e.message); } 
  },

  // 2. 系统日志 (System Log)
  async sys(level, type, message, req = null, metadata = null) {
    try {
      const ip = req ? (req.headers['x-forwarded-for'] || req.ip) : 'system';
      await pool.query(
        `INSERT INTO system_logs (level, type, message, metadata, ip, created_at) VALUES (?, ?, ?, ?, ?, NOW())`,
        [level, type, message, JSON.stringify(this.sanitize(metadata)), ip]
      );
    } catch (e) { console.error('写入系统日志失败:', e.message); }
  },

  // 3. 错误日志 (Error Log)
  async err(level, userId, pageUrl, apiUrl, errorType, errorMsg, stackTrace, req = null, reqParams = null) {
    try {
      const ua = req ? req.headers['user-agent'] : 'unknown';
      await pool.query(
        `INSERT INTO error_logs (level, user_id, page_url, api_url, error_type, error_msg, stack_trace, user_agent, request_params, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [level, userId || 'anonymous', pageUrl, apiUrl, errorType, errorMsg, stackTrace, ua, JSON.stringify(this.sanitize(reqParams))]
      );
    } catch (e) { console.error('写入错误日志失败:', e.message); }
  }
};

// =========================================================
// 全局中间件
// =========================================================

// 系统日志：记录所有 API 请求与状态码
app.use('/api', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (res.statusCode >= 400 && res.statusCode < 500) {
      logger.sys('WARNING', 'API_REQUEST', `${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`, req, req.body);
    } else if (res.statusCode >= 500) {
      logger.sys('ERROR', 'API_REQUEST', `${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`, req, req.body);
    }
  });
  next();
});

// JWT 身份验证拦截器
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: '访问受限，请先登录' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });
    req.user = user; 
    next();
  });
}

// =========================================================
// 数据库初始化与表结构自动生成
// =========================================================
async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // 1. 业务表
    await connection.query(`CREATE TABLE IF NOT EXISTS devices (id VARCHAR(50) PRIMARY KEY, name VARCHAR(100) NOT NULL, category VARCHAR(50) NOT NULL, categoryName VARCHAR(100), status VARCHAR(20) DEFAULT 'idle', location VARCHAR(100), sn VARCHAR(100), faultReason TEXT, createdAt DATETIME, creator VARCHAR(50), updatedAt DATETIME, updatedBy VARCHAR(50), specs TEXT)`);
    await connection.query(`CREATE TABLE IF NOT EXISTS reservations (id VARCHAR(50) PRIMARY KEY, deviceId VARCHAR(50) NOT NULL, mountedGpuId VARCHAR(50), startDate DATE NOT NULL, endDate DATE NOT NULL, applicant VARCHAR(100), project VARCHAR(100), purpose TEXT, serialNo VARCHAR(50), customAssembly TEXT)`);
    
    // 2. 鉴权与用户表
    await connection.query(`CREATE TABLE IF NOT EXISTS users (id VARCHAR(50) PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, name VARCHAR(50), employee_id VARCHAR(50) UNIQUE, avatar TEXT, phone VARCHAR(20), email VARCHAR(100), team_id VARCHAR(50), role_id VARCHAR(50), status VARCHAR(20) DEFAULT 'active', created_at DATETIME, updated_at DATETIME)`);
    await connection.query(`CREATE TABLE IF NOT EXISTS login_logs (id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(50), login_time DATETIME, ip VARCHAR(50), user_agent TEXT, device VARCHAR(100), status VARCHAR(20))`);
    
    // 3. 日志中心架构表
    await connection.query(`CREATE TABLE IF NOT EXISTS audit_logs (id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(50), username VARCHAR(50), action_type VARCHAR(50), module VARCHAR(50), target VARCHAR(100), old_data TEXT, new_data TEXT, ip VARCHAR(50), user_agent TEXT, result VARCHAR(20), error_msg TEXT, created_at DATETIME)`);
    await connection.query(`CREATE TABLE IF NOT EXISTS system_logs (id INT AUTO_INCREMENT PRIMARY KEY, level VARCHAR(20), type VARCHAR(50), message TEXT, metadata TEXT, ip VARCHAR(50), created_at DATETIME)`);
    await connection.query(`CREATE TABLE IF NOT EXISTS error_logs (id INT AUTO_INCREMENT PRIMARY KEY, level VARCHAR(20), user_id VARCHAR(50), page_url TEXT, api_url TEXT, error_type VARCHAR(100), error_msg TEXT, stack_trace TEXT, user_agent TEXT, request_params TEXT, created_at DATETIME)`);

    // 4. 初始化默认管理员
    const [userRows] = await connection.query('SELECT COUNT(*) AS count FROM users');
    if (userRows[0].count === 0) {
      const defaultHash = bcrypt.hashSync('123456', 10);
      await connection.query(`
        INSERT INTO users (id, username, password_hash, name, employee_id, avatar, phone, email, team_id, role_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, ['USR-1001', 'admin', defaultHash, '系统管理员', 'EMP-0001', 'JD', '13800138000', 'admin@liquid.glass', '基础架构组', 'SuperAdmin', 'active']);
    }

    // 5. 初始化业务演示数据
    const [devRows] = await connection.query('SELECT COUNT(*) AS count FROM devices');
    if (devRows[0].count === 0) {
      const seedDevices = [
        { id: 'DEV-RIG-001', name: 'Alpha-Compute-01', category: 'custom-rig', categoryName: '组装机器/节点', status: 'idle', location: 'B3 机房 A-02-14', sn: 'SN-NODE-2024-9981', createdAt: '2024-03-10 09:30:00', creator: 'System', specs: { cpu: 'AMD EPYC 9654', cpu_cores: '192 核心', cpu_freq: '2.4GHz 基准', cpu_threads: '384 线程', gpu: 'NVIDIA RTX 4090 24GB', gpu_vram: '24GB GDDR6X', ram_spec: '512GB DDR5', disk_type: '2x 3.84TB U.2 NVMe RAID1' } },
        { id: 'DEV-LAP-002', name: 'MacBook-Pro-Dev-01', category: 'laptop', categoryName: '笔记本', status: 'idle', location: '研发大厅 4F-B03', sn: 'C02G80XZMD6T', createdAt: '2024-03-10 09:30:00', creator: 'System', specs: { brand: 'Apple', model: 'MacBook Pro 16', has_power_cable: '是 (原装电源适配器)', cpu: 'Apple M3 Max', cpu_cores: '16 核心 (12P + 4E)', cpu_freq: '3.2GHz 基准', cpu_threads: '16 线程', gpu: '40 核 Apple GPU', gpu_vram: '128GB 统一内存', ram_spec: '128GB 6400MHz', disk_type: '纯固态 NVMe 2TB', screen_res: '3456 x 2234 Liquid XDR' } }
      ];
      for (const d of seedDevices) {
        await connection.query(`INSERT INTO devices (id, name, category, categoryName, status, location, sn, faultReason, createdAt, creator, specs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [d.id, d.name, d.category, d.categoryName, d.status, d.location, d.sn, d.faultReason || null, d.createdAt, d.creator, JSON.stringify(d.specs)]);
      }
    }

    connection.release();

    // 【新增】终端控制台直观的 MySQL 状态面板
    console.log(`\n🗄️  MySQL Database Connected Successfully!`);
    console.log(`🔌 DB Host   : ${dbConfig.host}`);
    console.log(`📦 DB Name   : ${dbConfig.database}`);
    console.log(`✅ DB Status : Tables Synced & Ready\n`);

    logger.sys('INFO', 'SYSTEM_STARTUP', 'MySQL 数据库表结构同步完成并成功启动服务');
  } catch (err) { 
    console.error(`\n❌ MySQL Database Connection Failed!`);
    console.error(`🔌 DB Host   : ${dbConfig.host}`);
    console.error(`📦 DB Name   : ${dbConfig.database}`);
    console.error(`⚠️ Error     : ${err.message}\n`);
    logger.sys('CRITICAL', 'DB_ERROR', `数据库初始化失败: ${err.message}`);
  }
}
initDatabase();

/* =========================================================
   RESTful API 路由模块
========================================================= */

// ---------------- 鉴权与个人中心 ----------------

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) {
      logger.audit('unknown', username, '登录', 'Auth', 'System', null, null, req, 'failed', '账户不存在');
      return res.status(401).json({ success: false, message: '账户不存在' });
    }

    const user = users[0];
    if (user.status !== 'active') {
      logger.audit(user.id, user.username, '登录', 'Auth', 'System', null, null, req, 'failed', '账户已被冻结');
      return res.status(403).json({ success: false, message: '账户已被冻结' });
    }

    const isMatch = bcrypt.compareSync(password, user.password_hash);
    if (!isMatch) {
      await pool.query('INSERT INTO login_logs (user_id, login_time, ip, user_agent, status) VALUES (?, NOW(), ?, ?, ?)', [user.id, req.ip, req.headers['user-agent'], 'failed']);
      logger.audit(user.id, user.username, '登录', 'Auth', 'System', null, null, req, 'failed', '密码错误');
      return res.status(401).json({ success: false, message: '用户名或密码错误' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role_id, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    await pool.query('INSERT INTO login_logs (user_id, login_time, ip, user_agent, status) VALUES (?, NOW(), ?, ?, ?)', [user.id, req.ip, req.headers['user-agent'], 'success']);
    
    logger.audit(user.id, user.username, '登录', 'Auth', 'System', null, null, req, 'success');
    res.json({ success: true, token, user: { name: user.name, role: user.role_id, avatar: user.avatar } });
  } catch (err) { 
    logger.err('ERROR', 'unknown', '/login.html', '/api/login', 'Login_Exception', err.message, err.stack, req, req.body);
    res.status(500).json({ success: false, message: '登录服务异常' }); 
  }
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  await pool.query('INSERT INTO login_logs (user_id, login_time, ip, user_agent, status) VALUES (?, NOW(), ?, ?, ?)', [req.user.id, req.ip, req.headers['user-agent'], 'logout']);
  logger.audit(req.user.id, req.user.username, '退出登录', 'Auth', 'System', null, null, req, 'success');
  res.json({ success: true, message: '登出成功' });
});

app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const [users] = await pool.query(`SELECT id, username, name, employee_id, avatar, phone, email, team_id, role_id, status, created_at, updated_at FROM users WHERE id = ?`, [req.user.id]);
    if (users.length === 0) return res.status(404).json({ success: false, message: '用户丢失' });
    const [logs] = await pool.query('SELECT * FROM login_logs WHERE user_id = ? ORDER BY login_time DESC LIMIT 10', [req.user.id]);
    res.json({ success: true, data: { ...users[0], login_logs: logs } });
  } catch (err) { 
    logger.err('ERROR', req.user.id, '/index.html', '/api/user/profile', 'DB_Exception', err.message, err.stack, req);
    res.status(500).json({ success: false, error: err.message }); 
  }
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
  const { name, phone, email, avatar } = req.body;
  try {
    const [oldUsers] = await pool.query('SELECT name, phone, email, avatar FROM users WHERE id = ?', [req.user.id]);
    const oldData = oldUsers[0];
    
    await pool.query(`UPDATE users SET name=?, phone=?, email=?, avatar=?, updated_at=NOW() WHERE id=?`, [name, phone, email, avatar, req.user.id]);
    
    const actionName = (oldData.avatar !== avatar) ? '修改头像和资料' : '修改个人资料';
    logger.audit(req.user.id, req.user.username, actionName, 'Profile', req.user.id, oldData, { name, phone, email, avatar }, req, 'success');
    
    res.json({ success: true, message: '资料更新成功' });
  } catch (err) { 
    logger.err('ERROR', req.user.id, '/index.html', '/api/user/profile', 'Update_Exception', err.message, err.stack, req, req.body);
    res.status(500).json({ success: false, error: err.message }); 
  }
});

app.put('/api/user/password', authenticateToken, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const [users] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const isMatch = bcrypt.compareSync(oldPassword, users[0].password_hash);
    if (!isMatch) {
      logger.audit(req.user.id, req.user.username, '修改密码', 'Security', req.user.id, null, null, req, 'failed', '原密码错误');
      return res.status(401).json({ success: false, message: '原密码错误' });
    }

    const newHash = bcrypt.hashSync(newPassword, 10);
    await pool.query('UPDATE users SET password_hash=?, updated_at=NOW() WHERE id=?', [newHash, req.user.id]);
    
    logger.audit(req.user.id, req.user.username, '修改密码', 'Security', req.user.id, null, null, req, 'success');
    res.json({ success: true, message: '密码修改成功' });
  } catch (err) { 
    logger.err('ERROR', req.user.id, '/index.html', '/api/user/password', 'Update_Pwd_Exception', err.message, err.stack, req);
    res.status(500).json({ success: false, error: err.message }); 
  }
});

// ---------------- 统一日志中心接入 ----------------

app.post('/api/logs/frontend', (req, res) => {
  const { error_type, error_msg, stack_trace, page_url, request_params } = req.body;
  
  let userId = 'Anonymous';
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch(e) { userId = 'Token_Expired_Or_Invalid'; }
  }
  
  logger.err('WARNING', userId, page_url, 'Frontend_Catch', error_type, error_msg, stack_trace, req, request_params);
  res.json({ success: true }); // 始终成功响应，不阻塞前端
});

app.get('/api/logs/:type', authenticateToken, async (req, res) => {
  if (req.user.role !== 'SuperAdmin') {
    logger.audit(req.user.id, req.user.username, '越权访问日志中心', 'Logs', 'System', null, null, req, 'failed', '权限不足');
    return res.status(403).json({ success: false, message: '无权访问' });
  }

  const { type } = req.params;
  const { keyword } = req.query;
  try {
    let data = [];
    if (type === 'audit') {
      let sql = 'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100';
      if (keyword) sql = `SELECT * FROM audit_logs WHERE username LIKE '%${keyword}%' OR action_type LIKE '%${keyword}%' ORDER BY created_at DESC LIMIT 100`;
      [data] = await pool.query(sql);
    } else if (type === 'system') {
      let sql = 'SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 100';
      if (keyword) sql = `SELECT * FROM system_logs WHERE message LIKE '%${keyword}%' ORDER BY created_at DESC LIMIT 100`;
      [data] = await pool.query(sql);
    } else if (type === 'error') {
      let sql = 'SELECT * FROM error_logs ORDER BY created_at DESC LIMIT 100';
      if (keyword) sql = `SELECT * FROM error_logs WHERE error_msg LIKE '%${keyword}%' ORDER BY created_at DESC LIMIT 100`;
      [data] = await pool.query(sql);
    }
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---------------- 设备与排期业务 ----------------

app.get('/api/devices', authenticateToken, async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM devices ORDER BY createdAt DESC'); res.json(rows); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/devices', authenticateToken, async (req, res) => {
  try {
    const d = req.body;
    await pool.query(`INSERT INTO devices (id, name, category, categoryName, status, location, sn, faultReason, createdAt, creator, updatedAt, updatedBy, specs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.id, d.name, d.category, d.categoryName, d.status, d.location, d.sn, d.faultReason, d.createdAt, d.creator, d.updatedAt, d.updatedBy, JSON.stringify(d.specs)]);
    
    // 增加操作日志
    logger.audit(req.user.id, req.user.username, '录入设备', 'Devices', d.name, null, d, req, 'success');
    res.status(201).json({ message: 'Device created successfully' });
  } catch (err) { 
    logger.err('ERROR', req.user.id, '/index.html', '/api/devices(POST)', 'DB_Exception', err.message, err.stack, req, req.body);
    res.status(500).json({ error: err.message }); 
  }
});

app.put('/api/devices/:id', authenticateToken, async (req, res) => {
  try {
    const d = req.body;
    const [oldRows] = await pool.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    
    await pool.query(`UPDATE devices SET name=?, status=?, location=?, sn=?, faultReason=?, updatedAt=?, updatedBy=?, specs=? WHERE id=?`,
      [d.name, d.status, d.location, d.sn, d.faultReason, d.updatedAt, d.updatedBy, JSON.stringify(d.specs), req.params.id]);
    
    // 增加操作日志
    logger.audit(req.user.id, req.user.username, '修改设备', 'Devices', d.name, oldRows[0], d, req, 'success');
    res.json({ message: 'Device updated successfully' });
  } catch (err) { 
    logger.err('ERROR', req.user.id, '/index.html', `/api/devices/${req.params.id}`, 'DB_Exception', err.message, err.stack, req, req.body);
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/reservations', authenticateToken, async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM reservations'); res.json(rows); } 
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reservations', authenticateToken, async (req, res) => {
  try {
    const r = req.body;
    await pool.query(`INSERT INTO reservations (id, deviceId, mountedGpuId, startDate, endDate, applicant, project, purpose, serialNo, customAssembly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.deviceId, r.mountedGpuId, r.startDate, r.endDate, r.applicant, r.project, r.purpose, r.serialNo, JSON.stringify(r.customAssembly)]);
    
    // 增加操作日志
    logger.audit(req.user.id, req.user.username, '创建排期预约', 'Schedule', r.deviceId, null, r, req, 'success');
    res.status(201).json({ message: 'Reservation created successfully' });
  } catch (err) { 
    logger.err('ERROR', req.user.id, '/index.html', '/api/reservations(POST)', 'DB_Exception', err.message, err.stack, req, req.body);
    res.status(500).json({ error: err.message }); 
  }
});

// 全局 500 兜底错误拦截 (写入 Error Log)
app.use((err, req, res, next) => {
  logger.err('CRITICAL', req.user ? req.user.id : 'anonymous', 'Backend_Node', req.originalUrl, err.name, err.message, err.stack, req, req.body);
  res.status(500).json({ success: false, message: '服务器内部严重错误' });
});

// 启动服务
app.listen(PORT, () => {
  console.log(`\n🌊 Liquid Glass Backend API Server is running...`);
  console.log(`🚀 API Base URL: http://localhost:${PORT}/api`);
  console.log(`🌐 Frontend UI  : http://localhost:${PORT}\n`);
});