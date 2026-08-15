const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(session({
  secret: 'attendance_secret_key_123',
  resave: false,
  saveUninitialized: false
}));

// ==================== 1. 数据库模型定义 ====================
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' }
});
const User = mongoose.model('User', userSchema);

const attendanceSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  clockIn: { type: Date, default: null },
  clockOut: { type: Date, default: null },
  workHours: { type: Number, default: 0 }, // 扣除1小时休息后的实际工时
  otHours: { type: Number, default: 0 },   // 超过8小时算OT
  isManual: { type: Boolean, default: false }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

// 连接 MongoDB 并自动强制创建/更新 Admin 账号
mongoose.connect('mongodb://127.0.0.1:27017/attendance_db')
  .then(async () => {
    console.log('✅ 成功连接至 MongoDB 数据库');
    
    // 生成加密密码
    const hashedPassword = await bcrypt.hash('123456789', 10);
    
    // 使用 findOneAndUpdate + upsert 强制自动写入或覆盖创建 admin123 账号
    await User.findOneAndUpdate(
      { userId: 'admin123' },
      {
        userId: 'admin123',
        password: hashedPassword,
        name: '系统管理员',
        role: 'admin'
      },
      { upsert: true, new: true }
    );
    console.log('👑 默认Admin已在MongoDB中自动写入/更新完成: admin123 / 123456789');
  })
  .catch(err => console.error('❌ MongoDB 连接失败，请确认本地 MongoDB 服务是否已启动:', err));

// 辅助函数
const getTodayStr = () => new Date().toISOString().split('T')[0];
const calculateHours = (inTime, outTime) => {
  if (!inTime || !outTime) return { workHours: 0, otHours: 0 };
  const diffMs = new Date(outTime) - new Date(inTime);
  const totalHours = Math.max(0, diffMs / (1000 * 60 * 60));
  const actualWork = Math.max(0, totalHours - 1); // 扣除1小时休息
  const ot = Math.max(0, actualWork - 8);
  const regularWork = Math.min(actualWork, 8);
  return {
    workHours: parseFloat(regularWork.toFixed(2)),
    otHours: parseFloat(ot.toFixed(2))
  };
};

// ==================== 2. API 路由 ====================

// 登录 API (增加了 try...catch 避免接口卡住住)
app.post('/api/login', async (req, res) => {
  try {
    const { userId, password } = req.body;
    const user = await User.findOne({ userId });
    if (!user) return res.status(400).json({ message: '账号不存在' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: '密码错误' });

    req.session.user = { userId: user.userId, role: user.role, name: user.name };
    res.json({ role: user.role, userId: user.userId });
  } catch (err) {
    console.error('登录异常:', err);
    res.status(500).json({ message: '服务器内部错误或数据库无法连接' });
  }
});

// 获取当前登录人
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录' });
  res.json(req.session.user);
});

// 退出登录
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Admin API：添加员工
app.post('/api/admin/add-employee', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { userId, password, name } = req.body;
  const exists = await User.findOne({ userId });
  if (exists) return res.status(400).json({ message: '员工ID已存在' });

  const hashedPassword = await bcrypt.hash(password, 10);
  await User.create({ userId, password: hashedPassword, name, role: 'employee' });
  res.json({ message: '员工添加成功' });
});

// Admin API：获取所有员工列表
app.get('/api/admin/employees', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const employees = await User.find({ role: 'employee' }, 'userId name');
  res.json(employees);
});

// 打卡数据 API：获取指定员工考勤数据
app.get('/api/attendance/:targetUserId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录' });
  
  const targetUserId = req.params.targetUserId;
  const today = getTodayStr();

  let todayRecord = await Attendance.findOne({ userId: targetUserId, date: today });
  const history = await Attendance.find({ userId: targetUserId }).sort({ date: -1 });

  const totals = history.reduce((acc, item) => {
    acc.totalWork += item.workHours || 0;
    acc.totalOt += item.otHours || 0;
    return acc;
  }, { totalWork: 0, totalOt: 0 });

  res.json({
    todayRecord,
    history,
    totalWorkHours: parseFloat(totals.totalWork.toFixed(2)),
    totalOtHours: parseFloat(totals.totalOt.toFixed(2))
  });
});

// 实时 Toggle 打卡 API
app.post('/api/attendance/toggle', async (req, res) => {
  const user = req.session.user;
  if (!user || user.role !== 'employee') return res.status(403).json({ message: '仅员工能进行此操作' });

  const today = getTodayStr();
  let record = await Attendance.findOne({ userId: user.userId, date: today });

  if (!record) {
    record = await Attendance.create({ userId: user.userId, date: today, clockIn: new Date() });
    return res.json({ message: '签到成功！', status: 'IN' });
  } else if (record.clockIn && !record.clockOut) {
    const now = new Date();
    const { workHours, otHours } = calculateHours(record.clockIn, now);
    record.clockOut = now;
    record.workHours = workHours;
    record.otHours = otHours;
    await record.save();
    return res.json({ message: '签退成功！', status: 'OUT' });
  } else {
    return res.status(400).json({ message: '今日打卡已完成，跨天后可再次打卡' });
  }
});

// 手动添加记录 API
app.post('/api/attendance/manual', async (req, res) => {
  const user = req.session.user;
  if (!user || user.role !== 'employee') return res.status(403).json({ message: '仅员工能进行此操作' });

  const { date, clockIn, clockOut } = req.body;
  if (!date || !clockIn || !clockOut) return res.status(400).json({ message: '请完整填写日期与时间' });

  const inDateTime = new Date(`${date}T${clockIn}`);
  const outDateTime = new Date(`${date}T${clockOut}`);
  if (outDateTime <= inDateTime) return res.status(400).json({ message: '签退时间必须晚于签到时间' });

  const { workHours, otHours } = calculateHours(inDateTime, outDateTime);
  await Attendance.findOneAndUpdate(
    { userId: user.userId, date },
    { userId: user.userId, date, clockIn: inDateTime, clockOut: outDateTime, workHours, otHours, isManual: true },
    { upsert: true, new: true }
  );

  res.json({ message: '打卡记录添加/更新成功' });
});

// ==================== 3. 前端页面路由 ====================

// 页面 1：登录界面
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>系统登录</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 h-screen flex items-center justify-center">
      <div class="bg-white p-8 rounded-xl shadow-md w-96">
        <h2 class="text-2xl font-bold mb-6 text-center text-gray-800">员工考勤系统登录</h2>
        <div id="errorMsg" class="text-red-500 text-sm mb-4 hidden text-center"></div>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700">账号 / 员工ID</label>
            <input type="text" id="userId" class="mt-1 w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700">密码</label>
            <input type="password" id="password" class="mt-1 w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <button onclick="login()" class="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold hover:bg-blue-700 transition">登录</button>
        </div>
      </div>
      <script>
        async function login() {
          const userId = document.getElementById('userId').value;
          const password = document.getElementById('password').value;
          const errorMsg = document.getElementById('errorMsg');
          errorMsg.classList.add('hidden');
          try {
            const res = await fetch('/api/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, password })
            });
            const data = await res.json();
            if (res.ok) {
              if (data.role === 'admin') location.href = '/admin';
              else location.href = '/employee';
            } else {
              errorMsg.innerText = data.message || '登录失败';
              errorMsg.classList.remove('hidden');
            }
          } catch (err) {
            errorMsg.innerText = '网络请求失败，请检查服务器连接';
            errorMsg.classList.remove('hidden');
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 页面 2：Admin 控制台
app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>管理员控制台</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50 min-h-screen p-8">
      <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-8">
          <h1 class="text-3xl font-bold text-gray-800">管理员控制台 (Admin)</h1>
          <button onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg">退出登录</button>
        </div>
        <div class="bg-white p-6 rounded-xl shadow-sm mb-8">
          <h2 class="text-xl font-bold mb-4">添加新员工</h2>
          <div class="grid grid-cols-3 gap-4">
            <input type="text" id="newId" placeholder="员工 ID (例如: emp01)" class="border p-2 rounded-lg">
            <input type="text" id="newName" placeholder="员工姓名" class="border p-2 rounded-lg">
            <input type="password" id="newPass" placeholder="初始密码" class="border p-2 rounded-lg">
          </div>
          <button onclick="addEmployee()" class="mt-4 bg-green-600 text-white px-6 py-2 rounded-lg font-semibold">添加员工</button>
        </div>
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4">员工列表 (点击员工查看其打卡页)</h2>
          <div id="employeeList" class="grid grid-cols-2 gap-4"></div>
        </div>
      </div>
      <script>
        async function init() {
          const res = await fetch('/api/me');
          const user = await res.json();
          if (!res.ok || user.role !== 'admin') location.href = '/';
          loadEmployees();
        }
        async function loadEmployees() {
          const res = await fetch('/api/admin/employees');
          const list = await res.json();
          const container = document.getElementById('employeeList');
          container.innerHTML = list.map(emp => \`
            <div onclick="viewEmployee('\${emp.userId}')" class="p-4 border rounded-xl cursor-pointer hover:border-blue-500 hover:shadow-md transition bg-gray-50">
              <div class="font-bold text-lg text-blue-600">\${emp.userId}</div>
              <div class="text-gray-600">\${emp.name}</div>
            </div>
          \`).join('');
        }
        async function addEmployee() {
          const userId = document.getElementById('newId').value;
          const name = document.getElementById('newName').value;
          const password = document.getElementById('newPass').value;
          const res = await fetch('/api/admin/add-employee', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, name, password })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            document.getElementById('newId').value = '';
            document.getElementById('newName').value = '';
            document.getElementById('newPass').value = '';
            loadEmployees();
          }
        }
        function viewEmployee(userId) {
          location.href = \`/employee?viewUserId=\${userId}\`;
        }
        async function logout() {
          await fetch('/api/logout', { method: 'POST' });
          location.href = '/';
        }
        init();
      </script>
    </body>
    </html>
  `);
});

// 页面 3：员工打卡/查看打卡页
app.get('/employee', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>员工打卡页面</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        @media print {
          .no-print { display: none !important; }
          body { background: white; padding: 0; }
          .shadow-sm, .shadow-md { box-shadow: none !important; }
        }
      </style>
    </head>
    <body class="bg-gray-50 min-h-screen p-8">
      <div class="max-w-4xl mx-auto space-y-6">
        <div class="flex justify-between items-center bg-white p-6 rounded-xl shadow-sm">
          <div>
            <h1 class="text-2xl font-bold">员工打卡控制台</h1>
            <p class="text-gray-500 mt-1">当前查看员工 ID: <span id="dispUserId" class="font-bold text-blue-600">---</span></p>
          </div>
          <div class="space-x-2 no-print">
            <button onclick="window.print()" class="bg-gray-700 text-white px-4 py-2 rounded-lg">🖨️ 打印记录</button>
            <button id="logoutBtn" onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg">退出登录</button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-6">
          <div class="bg-white p-6 rounded-xl shadow-sm col-span-2">
            <h3 class="text-sm font-semibold text-gray-400 mb-2">累计考勤统计</h3>
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-blue-50 p-4 rounded-lg">
                <div class="text-gray-500 text-sm">总工作时长 (已扣除休息)</div>
                <div class="text-3xl font-extrabold text-blue-600 mt-1"><span id="totalWork">0</span> 小时</div>
              </div>
              <div class="bg-orange-50 p-4 rounded-lg">
                <div class="text-gray-500 text-sm">总 OT (加班时长)</div>
                <div class="text-3xl font-extrabold text-orange-600 mt-1"><span id="totalOt">0</span> 小时</div>
              </div>
            </div>
          </div>
          <div id="clockArea" class="bg-white p-6 rounded-xl shadow-sm flex flex-col justify-center items-center no-print">
            <button id="clockBtn" onclick="toggleClock()" class="w-full h-24 text-xl font-bold rounded-xl text-white transition bg-green-500 hover:bg-green-600">
              上班打卡 (IN)
            </button>
            <p id="clockStatus" class="text-xs text-gray-400 mt-2 text-center">点击记录当前时刻</p>
          </div>
        </div>
        <div id="manualArea" class="bg-white p-6 rounded-xl shadow-sm no-print">
          <h3 class="text-lg font-bold mb-4">添加/补录打卡记录</h3>
          <div class="grid grid-cols-4 gap-4">
            <input type="date" id="mDate" class="border p-2 rounded-lg">
            <div>
              <label class="text-xs text-gray-400">上班时间</label>
              <input type="time" id="mIn" class="border p-2 rounded-lg w-full">
            </div>
            <div>
              <label class="text-xs text-gray-400">下班时间</label>
              <input type="time" id="mOut" class="border p-2 rounded-lg w-full">
            </div>
            <div class="flex items-end">
              <button onclick="addManualRecord()" class="bg-indigo-600 text-white w-full py-2 rounded-lg font-semibold">保存记录</button>
            </div>
          </div>
        </div>
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h3 class="text-lg font-bold mb-4">打卡历史记录</h3>
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b bg-gray-50 text-gray-600 text-sm">
                <th class="p-3">日期</th>
                <th class="p-3">上班打卡</th>
                <th class="p-3">下班打卡</th>
                <th class="p-3">实际工时</th>
                <th class="p-3">OT 时长</th>
                <th class="p-3">类型</th>
              </tr>
            </thead>
            <tbody id="historyTable" class="divide-y text-sm"></tbody>
          </table>
        </div>
      </div>
      <script>
        const urlParams = new URLSearchParams(window.location.search);
        const viewUserId = urlParams.get('viewUserId');
        let currentUser = null;
        let targetUserId = '';
        async function init() {
          const res = await fetch('/api/me');
          if (!res.ok) return location.href = '/';
          currentUser = await res.json();
          if (viewUserId && currentUser.role === 'admin') {
            targetUserId = viewUserId;
            document.getElementById('clockArea').classList.add('hidden');
            document.getElementById('manualArea').classList.add('hidden');
          } else {
            targetUserId = currentUser.userId;
          }
          document.getElementById('dispUserId').innerText = targetUserId;
          loadAttendanceData();
        }
        async function loadAttendanceData() {
          const res = await fetch(\`/api/attendance/\${targetUserId}\`);
          const data = await res.json();
          document.getElementById('totalWork').innerText = data.totalWorkHours;
          document.getElementById('totalOt').innerText = data.totalOtHours;
          if (currentUser.role === 'employee') {
            const btn = document.getElementById('clockBtn');
            const status = document.getElementById('clockStatus');
            if (!data.todayRecord || !data.todayRecord.clockIn) {
              btn.innerText = "上班打卡 (IN)";
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-green-500 hover:bg-green-600 transition";
              status.innerText = "状态：未打卡";
            } else if (data.todayRecord.clockIn && !data.todayRecord.clockOut) {
              btn.innerText = "下班打卡 (OUT)";
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-red-500 hover:bg-red-600 transition";
              status.innerText = \`已签到：\${new Date(data.todayRecord.clockIn).toLocaleTimeString()}\`;
            } else {
              btn.innerText = "今日打卡完成";
              btn.disabled = true;
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-gray-400 cursor-not-allowed";
              status.innerText = "明日12点后自动刷新";
            }
          }
          const table = document.getElementById('historyTable');
          table.innerHTML = data.history.map(row => \`
            <tr>
              <td class="p-3 font-medium">\${row.date}</td>
              <td class="p-3">\${row.clockIn ? new Date(row.clockIn).toLocaleTimeString() : '-'}</td>
              <td class="p-3">\${row.clockOut ? new Date(row.clockOut).toLocaleTimeString() : '-'}</td>
              <td class="p-3 font-semibold text-blue-600">\${row.workHours} 小时</td>
              <td class="p-3 font-semibold text-orange-600">\${row.otHours} 小时</td>
              <td class="p-3"><span class="px-2 py-1 text-xs rounded \${row.isManual ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}">\${row.isManual ? '手动补录' : '实时打卡'}</span></td>
            </tr>
          \`).join('');
        }
        async function toggleClock() {
          const res = await fetch('/api/attendance/toggle', { method: 'POST' });
          const data = await res.json();
          alert(data.message);
          loadAttendanceData();
        }
        async function addManualRecord() {
          const date = document.getElementById('mDate').value;
          const clockIn = document.getElementById('mIn').value;
          const clockOut = document.getElementById('mOut').value;
          const res = await fetch('/api/attendance/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, clockIn, clockOut })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) loadAttendanceData();
        }
        async function logout() {
          await fetch('/api/logout', { method: 'POST' });
          location.href = '/';
        }
        init();
      </script>
    </body>
    </html>
  `);
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 服务已启动在: http://localhost:${PORT}`));
