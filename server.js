const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// 时区配置
const TIMEZONE_OFFSET = '+08:00'; 
const TIMEZONE_NAME = 'Asia/Kuala_Lumpur';

// 数据库连接字符串
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://woyaonpy2005_db_user:Lim050831.@cluster0.ztvp8bb.mongodb.net/attendance_db?appName=Cluster0";

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
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
  status: { type: String, enum: ['active', 'resigned'], default: 'active' } // 增加员工状态
});
const User = mongoose.model('User', userSchema);

const attendanceSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  clockIn: { type: Date, default: null },
  clockOut: { type: Date, default: null },
  workHours: { type: Number, default: 0 },
  otHours: { type: Number, default: 0 },
  isManual: { type: Boolean, default: false }
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

// 连接 MongoDB Atlas
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('✅ 成功连接至 MongoDB Atlas 云数据库');
    const adminExists = await User.findOne({ userId: 'admin123' });
    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('123456789', 10);
      await User.create({
        userId: 'admin123',
        password: hashedPassword,
        name: '系统管理员',
        role: 'admin'
      });
      console.log('👑 默认Admin初始化完成: admin123 / 123456789');
    }
  })
  .catch(err => console.error('❌ MongoDB Atlas 连接失败:', err));

// 辅助函数：按本地时区获取 YYYY-MM-DD 或 YYYY-MM
const getTodayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE_NAME });
const getCurrentMonthStr = () => getTodayStr().slice(0, 7);

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

// 登录 API
app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.status(400).json({ message: '账号不存在' });
  if (user.status === 'resigned') return res.status(403).json({ message: '该员工账号已标记为离职，禁用登录' });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).json({ message: '密码错误' });

  req.session.user = { userId: user.userId, role: user.role, name: user.name };
  res.json({ role: user.role, userId: user.userId });
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
  if (!userId || !password || !name) return res.status(400).json({ message: '请填写完整资料' });

  const exists = await User.findOne({ userId });
  if (exists) return res.status(400).json({ message: '员工ID已存在' });

  const hashedPassword = await bcrypt.hash(password, 10);
  await User.create({ userId, password: hashedPassword, name, role: 'employee', status: 'active' });
  res.json({ message: '员工添加成功' });
});

// Admin API：修改员工资料（ID、姓名、新密码）
app.post('/api/admin/update-employee', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { oldUserId, newUserId, newName, newPassword } = req.body;
  
  const user = await User.findOne({ userId: oldUserId });
  if (!user) return res.status(404).json({ message: '找不到该员工' });

  // 如果修改了 ID，检测冲突
  if (oldUserId !== newUserId) {
    const duplicate = await User.findOne({ userId: newUserId });
    if (duplicate) return res.status(400).json({ message: '新的员工 ID 已被占用' });
    user.userId = newUserId;
    // 同步更新打卡历史中的 ID
    await Attendance.updateMany({ userId: oldUserId }, { userId: newUserId });
  }

  if (newName) user.name = newName;
  if (newPassword) user.password = await bcrypt.hash(newPassword, 10);

  await user.save();
  res.json({ message: '员工资料更新成功！' });
});

// Admin API：离职/恢复状态切换
app.post('/api/admin/toggle-status', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { targetUserId, status } = req.body;
  await User.findOneAndUpdate({ userId: targetUserId }, { status });
  res.json({ message: `员工状态已更新为：${status === 'resigned' ? '已离职' : '在职'}` });
});

// Admin API：删除员工
app.delete('/api/admin/delete-employee', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { targetUserId } = req.body;
  await User.findOneAndDelete({ userId: targetUserId });
  await Attendance.deleteMany({ userId: targetUserId });
  res.json({ message: '员工及其关联考勤记录已彻底删除' });
});

// Admin API：获取所有员工列表
app.get('/api/admin/employees', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const employees = await User.find({ role: 'employee' }, 'userId name status');
  res.json(employees);
});

// 获取指定员工考勤数据 (按月份支持)
app.get('/api/attendance/:targetUserId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录' });
  
  const targetUserId = req.params.targetUserId;
  const month = req.query.month || getCurrentMonthStr(); // 格式 YYYY-MM
  const today = getTodayStr();

  let todayRecord = await Attendance.findOne({ userId: targetUserId, date: today });
  
  // 按月份正向/倒序查询
  const monthRegex = new RegExp(`^${month}`);
  const history = await Attendance.find({ userId: targetUserId, date: monthRegex }).sort({ date: -1 });

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

// 手动添加/修改记录 API
app.post('/api/attendance/manual', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: '未登录' });

  let { date, clockIn, clockOut, targetUserId } = req.body;
  if (!date || !clockIn || !clockOut) return res.status(400).json({ message: '请选择完整的日期与时间' });

  const updateUserId = (user.role === 'admin' && targetUserId) ? targetUserId : user.userId;

  const inDateTime = new Date(`${date}T${clockIn}:00${TIMEZONE_OFFSET}`);
  const outDateTime = new Date(`${date}T${clockOut}:00${TIMEZONE_OFFSET}`);

  if (isNaN(inDateTime.getTime()) || isNaN(outDateTime.getTime())) {
    return res.status(400).json({ message: '输入的日期或时间格式不正确' });
  }

  if (outDateTime <= inDateTime) return res.status(400).json({ message: '签退时间必须晚于签到时间' });

  const { workHours, otHours } = calculateHours(inDateTime, outDateTime);
  await Attendance.findOneAndUpdate(
    { userId: updateUserId, date },
    { userId: updateUserId, date, clockIn: inDateTime, clockOut: outDateTime, workHours, otHours, isManual: true },
    { upsert: true, new: true }
  );

  res.json({ message: '打卡记录已更新/保存成功！' });
});

// 删除打卡记录 API
app.delete('/api/attendance/delete', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: '未登录' });

  const { date, targetUserId } = req.body;
  if (!date) return res.status(400).json({ message: '缺少参数：日期' });

  const deleteUserId = (user.role === 'admin' && targetUserId) ? targetUserId : user.userId;

  const deleted = await Attendance.findOneAndDelete({ userId: deleteUserId, date });
  if (!deleted) return res.status(404).json({ message: '未找到该日期的打卡记录' });

  res.json({ message: '记录已成功删除！' });
});

// ==================== 3. 前端页面路由 ====================

// 页面 1：登录界面
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>系统登录</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 min-h-screen flex items-center justify-center p-4">
      <div class="bg-white p-6 md:p-8 rounded-xl shadow-md w-full max-w-md">
        <h2 class="text-2xl font-bold mb-6 text-center text-gray-800">员工考勤系统登录</h2>
        <div id="errorMsg" class="text-red-500 text-sm mb-4 hidden text-center"></div>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700">账号 / 员工ID</label>
            <input type="text" id="userId" class="mt-1 w-full border rounded-lg p-2 focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700">密码</label>
            <div class="relative mt-1">
              <input type="password" id="password" class="w-full border rounded-lg p-2 pr-10 focus:ring-2 focus:ring-blue-500 outline-none">
              <button type="button" onclick="togglePasswordVisibility('password', 'eyeIcon')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeIcon">👁️</span>
              </button>
            </div>
          </div>
          <button onclick="login()" class="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold hover:bg-blue-700 transition">登录</button>
        </div>
      </div>
      <script>
        function togglePasswordVisibility(inputId, eyeIconId) {
          const input = document.getElementById(inputId);
          const icon = document.getElementById(eyeIconId);
          if (input.type === 'password') {
            input.type = 'text'; icon.innerText = '🙈';
          } else {
            input.type = 'password'; icon.innerText = '👁️';
          }
        }

        async function login() {
          const userId = document.getElementById('userId').value;
          const password = document.getElementById('password').value;
          const errorMsg = document.getElementById('errorMsg');
          errorMsg.classList.add('hidden');
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
            errorMsg.innerText = data.message;
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
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>管理员控制台</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-50 min-h-screen p-4 md:p-8">
      <div class="max-w-5xl mx-auto space-y-6">
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-xl shadow-sm">
          <h1 class="text-2xl md:text-3xl font-bold text-gray-800">管理员控制台 (Admin)</h1>
          <button onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg w-full md:w-auto">退出登录</button>
        </div>

        <!-- 添加员工 -->
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4">添加新员工</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input type="text" id="newId" placeholder="员工 ID (例: emp01)" class="border p-2 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <input type="text" id="newName" placeholder="员工姓名" class="border p-2 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <div class="relative">
              <input type="password" id="newPass" placeholder="初始密码" class="border p-2 pr-10 rounded-lg w-full outline-none focus:ring-2 focus:ring-green-500">
              <button type="button" onclick="togglePasswordVisibility('newPass', 'eyeNew')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeNew">👁️</span>
              </button>
            </div>
          </div>
          <button onclick="addEmployee()" class="mt-4 bg-green-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-green-700 w-full md:w-auto transition">添加员工</button>
        </div>

        <!-- 员工列表管理 -->
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4">员工列表管理</h2>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr class="border-b bg-gray-50 text-gray-600 text-sm">
                  <th class="p-3">员工 ID</th>
                  <th class="p-3">姓名</th>
                  <th class="p-3">状态</th>
                  <th class="p-3">操作</th>
                </tr>
              </thead>
              <tbody id="employeeListTable" class="divide-y text-sm"></tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 修改员工 Modal 弹窗 -->
      <div id="editModal" class="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center hidden p-4">
        <div class="bg-white p-6 rounded-xl shadow-lg w-full max-w-md space-y-4">
          <h3 class="text-lg font-bold">修改员工资料</h3>
          <input type="hidden" id="editOldUserId">
          <div>
            <label class="text-xs text-gray-500">员工 ID</label>
            <input type="text" id="editUserId" class="border p-2 rounded-lg w-full outline-none">
          </div>
          <div>
            <label class="text-xs text-gray-500">员工姓名</label>
            <input type="text" id="editName" class="border p-2 rounded-lg w-full outline-none">
          </div>
          <div>
            <label class="text-xs text-gray-500">新密码 (留空则不修改)</label>
            <div class="relative">
              <input type="password" id="editPass" placeholder="设置新密码" class="border p-2 pr-10 rounded-lg w-full outline-none">
              <button type="button" onclick="togglePasswordVisibility('editPass', 'eyeEdit')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeEdit">👁️</span>
              </button>
            </div>
          </div>
          <div class="flex justify-end space-x-2 pt-2">
            <button onclick="closeEditModal()" class="px-4 py-2 border rounded-lg text-gray-600">取消</button>
            <button onclick="saveEditModal()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存修改</button>
          </div>
        </div>
      </div>

      <script>
        function togglePasswordVisibility(inputId, eyeIconId) {
          const input = document.getElementById(inputId);
          const icon = document.getElementById(eyeIconId);
          if (input.type === 'password') { input.type = 'text'; icon.innerText = '🙈'; } 
          else { input.type = 'password'; icon.innerText = '👁️'; }
        }

        async function init() {
          const res = await fetch('/api/me');
          const user = await res.json();
          if (!res.ok || user.role !== 'admin') location.href = '/';
          loadEmployees();
        }

        async function loadEmployees() {
          const res = await fetch('/api/admin/employees');
          const list = await res.json();
          
          const tbody = document.getElementById('employeeListTable');
          tbody.innerHTML = list.map(emp => \`
            <tr class="\${emp.status === 'resigned' ? 'bg-gray-100 opacity-60' : ''}">
              <td class="p-3 font-bold text-blue-600 cursor-pointer" onclick="viewEmployee('\${emp.userId}')">\${emp.userId}</td>
              <td class="p-3 font-medium">\${emp.name}</td>
              <td class="p-3">
                <span class="px-2 py-1 text-xs rounded \${emp.status === 'resigned' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}">
                  \${emp.status === 'resigned' ? '已离职' : '在职'}
                </span>
              </td>
              <td class="p-3 space-x-1 space-y-1">
                <button onclick="viewEmployee('\${emp.userId}')" class="text-blue-600 border border-blue-200 px-2 py-1 rounded text-xs hover:bg-blue-50">👁️ 考勤记录</button>
                <button onclick="openEditModal('\${emp.userId}', '\${emp.name}')" class="text-indigo-600 border border-indigo-200 px-2 py-1 rounded text-xs hover:bg-indigo-50">✏️ 修改资料</button>
                <button onclick="toggleStatus('\${emp.userId}', '\${emp.status}')" class="text-orange-600 border border-orange-200 px-2 py-1 rounded text-xs hover:bg-orange-50">
                  \${emp.status === 'resigned' ? '🔄 设为在职' : '🚫 标记离职'}
                </button>
                <button onclick="deleteEmployee('\${emp.userId}')" class="text-red-600 border border-red-200 px-2 py-1 rounded text-xs hover:bg-red-50">🗑️ 删除</button>
              </td>
            </tr>
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

        function openEditModal(userId, name) {
          document.getElementById('editOldUserId').value = userId;
          document.getElementById('editUserId').value = userId;
          document.getElementById('editName').value = name;
          document.getElementById('editPass').value = '';
          document.getElementById('editModal').classList.remove('hidden');
        }

        function closeEditModal() {
          document.getElementById('editModal').classList.add('hidden');
        }

        async function saveEditModal() {
          const oldUserId = document.getElementById('editOldUserId').value;
          const newUserId = document.getElementById('editUserId').value;
          const newName = document.getElementById('editName').value;
          const newPassword = document.getElementById('editPass').value;

          const res = await fetch('/api/admin/update-employee', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldUserId, newUserId, newName, newPassword })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            closeEditModal();
            loadEmployees();
          }
        }

        async function toggleStatus(targetUserId, currentStatus) {
          const newStatus = currentStatus === 'resigned' ? 'active' : 'resigned';
          if (!confirm(\`确定要将员工 \${targetUserId} 切换为 \${newStatus === 'resigned' ? '已离职' : '在职'} 状态吗？\`)) return;

          const res = await fetch('/api/admin/toggle-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUserId, status: newStatus })
          });
          const data = await res.json();
          alert(data.message);
          loadEmployees();
        }

        async function deleteEmployee(targetUserId) {
          if (!confirm(\`⚠️ 警告: 删除员工 \${targetUserId} 将永久彻底清空该员工的一切打卡数据！确定继续？\`)) return;

          const res = await fetch('/api/admin/delete-employee', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUserId })
          });
          const data = await res.json();
          alert(data.message);
          loadEmployees();
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

// 页面 3：员工打卡/修改打卡页
app.get('/employee', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>员工打卡页面</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
      <script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
      <style>
        @media print {
          .no-print { display: none !important; }
          body { background: white; padding: 0; }
          .shadow-sm, .shadow-md { box-shadow: none !important; }
        }
      </style>
    </head>
    <body class="bg-gray-50 min-h-screen p-4 md:p-8">
      <div class="max-w-4xl mx-auto space-y-6">
        <!-- 头部 Header -->
        <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white p-6 rounded-xl shadow-sm">
          <div>
            <h1 class="text-2xl font-bold">员工打卡控制台</h1>
            <p class="text-gray-500 mt-1 text-sm">当前查看员工 ID: <span id="dispUserId" class="font-bold text-blue-600">---</span></p>
          </div>
          <div class="space-x-2 no-print w-full md:w-auto flex">
            <button onclick="window.print()" class="bg-gray-700 text-white px-4 py-2 rounded-lg text-sm flex-1 md:flex-none">🖨️ 打印记录</button>
            <button id="logoutBtn" onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg text-sm flex-1 md:flex-none">退出登录</button>
          </div>
        </div>

        <!-- 统计面板与打卡按钮 -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div class="bg-white p-6 rounded-xl shadow-sm md:col-span-2">
            <div class="flex justify-between items-center mb-4">
              <h3 class="text-sm font-semibold text-gray-500">月份考勤统计</h3>
              <!-- 月份选择器 -->
              <input type="month" id="monthFilter" onchange="loadAttendanceData()" class="border p-1 rounded-lg text-sm bg-gray-50 outline-none">
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-blue-50 p-4 rounded-lg">
                <div class="text-gray-500 text-xs md:text-sm">当月总工时 (扣除休息)</div>
                <div class="text-2xl md:text-3xl font-extrabold text-blue-600 mt-1"><span id="totalWork">0</span> 小时</div>
              </div>
              <div class="bg-orange-50 p-4 rounded-lg">
                <div class="text-gray-500 text-xs md:text-sm">当月总 OT (加班)</div>
                <div class="text-2xl md:text-3xl font-extrabold text-orange-600 mt-1"><span id="totalOt">0</span> 小时</div>
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

        <!-- 补录与修改区域 -->
        <div id="manualArea" class="bg-white p-6 rounded-xl shadow-sm no-print">
          <h3 id="formTitle" class="text-lg font-bold mb-4">添加/修改打卡记录</h3>
          <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label class="text-xs text-gray-400">选择日期</label>
              <input type="text" id="mDate" placeholder="选择日期" class="border p-2 rounded-lg w-full bg-white cursor-pointer">
            </div>
            <div>
              <label class="text-xs text-gray-400">上班时间 (24小时制)</label>
              <input type="text" id="mIn" placeholder="选择上班时间" class="border p-2 rounded-lg w-full bg-white cursor-pointer">
            </div>
            <div>
              <label class="text-xs text-gray-400">下班时间 (24小时制)</label>
              <input type="text" id="mOut" placeholder="选择下班时间" class="border p-2 rounded-lg w-full bg-white cursor-pointer">
            </div>
            <div class="flex items-end">
              <button onclick="addManualRecord()" class="bg-indigo-600 text-white w-full py-2 rounded-lg font-semibold hover:bg-indigo-700 transition">保存记录</button>
            </div>
          </div>
        </div>

        <!-- 历史记录表格 -->
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h3 class="text-lg font-bold mb-4">打卡历史记录</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr class="border-b bg-gray-50 text-gray-600 text-sm">
                  <th class="p-3">日期</th>
                  <th class="p-3">上班打卡</th>
                  <th class="p-3">下班打卡</th>
                  <th class="p-3">实际工时</th>
                  <th class="p-3">OT 时长</th>
                  <th class="p-3">类型</th>
                  <th class="p-3 no-print">操作</th>
                </tr>
              </thead>
              <tbody id="historyTable" class="divide-y text-sm"></tbody>
            </table>
          </div>
          <!-- 点击查看更多按钮 -->
          <div id="showMoreContainer" class="mt-4 text-center hidden no-print">
            <button onclick="toggleShowAll()" id="showMoreBtn" class="text-blue-600 font-semibold text-sm hover:underline">
              👇 点击查看更多历史记录
            </button>
          </div>
        </div>
      </div>

      <script>
        const urlParams = new URLSearchParams(window.location.search);
        const viewUserId = urlParams.get('viewUserId');
        let currentUser = null;
        let targetUserId = '';
        let pickerIn, pickerOut, pickerDate;
        
        let allMonthRecords = []; // 当月所有数据
        let showAll = false; // 是否展开了全部记录

        function initTimePickers() {
          pickerDate = flatpickr("#mDate", { dateFormat: "Y-m-d" });
          pickerIn = flatpickr("#mIn", { enableTime: true, noCalendar: true, dateFormat: "H:i", time_24hr: true });
          pickerOut = flatpickr("#mOut", { enableTime: true, noCalendar: true, dateFormat: "H:i", time_24hr: true });
        }

        function formatTo24HourTime(dateIsoStr) {
          if (!dateIsoStr) return '';
          const d = new Date(dateIsoStr);
          if (isNaN(d.getTime())) return '';
          return d.toLocaleTimeString('zh-CN', {
            hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kuala_Lumpur'
          });
        }

        async function init() {
          initTimePickers();
          
          // 初始化默认月份为当月 YYYY-MM
          const now = new Date();
          const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          document.getElementById('monthFilter').value = currentMonth;

          const res = await fetch('/api/me');
          if (!res.ok) return location.href = '/';
          currentUser = await res.json();
          if (viewUserId && currentUser.role === 'admin') {
            targetUserId = viewUserId;
            document.getElementById('clockArea').classList.add('hidden');
          } else {
            targetUserId = currentUser.userId;
          }
          document.getElementById('dispUserId').innerText = targetUserId;
          loadAttendanceData();
        }

        async function loadAttendanceData() {
          const selectedMonth = document.getElementById('monthFilter').value;
          const res = await fetch(\`/api/attendance/\${targetUserId}?month=\${selectedMonth}\`);
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
              status.innerText = \`已签到：\${formatTo24HourTime(data.todayRecord.clockIn)}\`;
            } else {
              btn.innerText = "今日打卡完成";
              btn.disabled = true;
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-gray-400 cursor-not-allowed";
              status.innerText = "明日跨天后可再次打卡";
            }
          }

          allMonthRecords = data.history;
          renderHistoryTable();
        }

        function renderHistoryTable() {
          const table = document.getElementById('historyTable');
          const showMoreContainer = document.getElementById('showMoreContainer');
          const showMoreBtn = document.getElementById('showMoreBtn');

          // 如果不展开且大于7条，截取前7条展示
          const displayRecords = (showAll || allMonthRecords.length <= 7) ? allMonthRecords : allMonthRecords.slice(0, 7);

          if (allMonthRecords.length > 7) {
            showMoreContainer.classList.remove('hidden');
            showMoreBtn.innerText = showAll ? "👆 收起展示最近 7 天记录" : `👇 点击查看更多 (共 ${allMonthRecords.length} 条记录)`;
          } else {
            showMoreContainer.classList.add('hidden');
          }

          table.innerHTML = displayRecords.map(row => {
            const inTime24 = formatTo24HourTime(row.clockIn);
            const outTime24 = formatTo24HourTime(row.clockOut);
            
            return \`
              <tr>
                <td class="p-3 font-medium">\${row.date}</td>
                <td class="p-3">\${inTime24 || '-'}</td>
                <td class="p-3">\${outTime24 || '-'}</td>
                <td class="p-3 font-semibold text-blue-600">\${row.workHours} 小时</td>
                <td class="p-3 font-semibold text-orange-600">\${row.otHours} 小时</td>
                <td class="p-3"><span class="px-2 py-1 text-xs rounded \${row.isManual ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}">\${row.isManual ? '手动补录/修改' : '实时打卡'}</span></td>
                <td class="p-3 no-print space-x-2">
                  <button onclick="editRow('\${row.date}', '\${inTime24}', '\${outTime24}')" class="text-indigo-600 hover:text-indigo-900 font-semibold text-xs border border-indigo-200 px-2 py-1 rounded hover:bg-indigo-50 transition">✏️ 修改</button>
                  <button onclick="deleteRow('\${row.date}')" class="text-red-600 hover:text-red-900 font-semibold text-xs border border-red-200 px-2 py-1 rounded hover:bg-red-50 transition">🗑️ 删除</button>
                </td>
              </tr>
            \`;
          }).join('');
        }

        function toggleShowAll() {
          showAll = !showAll;
          renderHistoryTable();
        }

        function editRow(date, clockIn, clockOut) {
          pickerDate.setDate(date);
          pickerIn.setDate(clockIn);
          pickerOut.setDate(clockOut);
          document.getElementById('manualArea').scrollIntoView({ behavior: 'smooth' });
        }

        async function deleteRow(date) {
          if (!confirm(\`确定要删除 \${date} 的打卡记录吗？\`)) return;

          const res = await fetch('/api/attendance/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, targetUserId })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) loadAttendanceData();
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
          
          if (!date || !clockIn || !clockOut) {
            return alert('请完整选择日期以及具体的上下班时间！');
          }

          const res = await fetch('/api/attendance/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, clockIn, clockOut, targetUserId })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            pickerDate.clear(); pickerIn.clear(); pickerOut.clear();
            loadAttendanceData();
          }
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

app.listen(PORT, () => {
  console.log(`🚀 服务已启动，监听端口: ${PORT}`);
});
