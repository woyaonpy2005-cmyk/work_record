const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// 💡 配置所在的时区偏移量（如马来西亚/中国时间为 +08:00）
const TIMEZONE_OFFSET = '+08:00'; 
const TIMEZONE_NAME = 'Asia/Kuala_Lumpur';

// 💡 数据库连接字符串
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
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' }
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

// 辅助函数：按本地时区获取 YYYY-MM-DD
const getTodayStr = () => {
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE_NAME });
};

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
  if (!userId || !password || !name) return res.status(400).json({ message: '请填写完整员工信息' });

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

// Admin API：修改员工信息 (支持修改 ID, 名字, 密码)
app.post('/api/admin/update-employee', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { originalUserId, newUserId, newName, newPassword } = req.body;
  if (!originalUserId || !newUserId || !newName) {
    return res.status(400).json({ message: '请填写完整的员工信息' });
  }

  // 如果修改了 ID，检查新 ID 是否被其他账号占用
  if (originalUserId !== newUserId) {
    const exists = await User.findOne({ userId: newUserId });
    if (exists) return res.status(400).json({ message: '新员工ID已被其他账号占用' });
  }

  const user = await User.findOne({ userId: originalUserId });
  if (!user) return res.status(404).json({ message: '找不到该员工' });

  // 更新员工字段
  user.userId = newUserId;
  user.name = newName;
  if (newPassword && newPassword.trim() !== '') {
    user.password = await bcrypt.hash(newPassword, 10);
  }
  await user.save();

  // 如果员工 ID 发生了改变，同步更新该员工过去的所有考勤记录
  if (originalUserId !== newUserId) {
    await Attendance.updateMany({ userId: originalUserId }, { userId: newUserId });
  }

  res.json({ message: '员工信息修改成功！' });
});

// Admin API：删除/离职员工 (清理员工账号及其打卡记录)
app.delete('/api/admin/delete-employee', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ message: '缺少参数：员工ID' });

  // 删除账号
  const deletedUser = await User.findOneAndDelete({ userId: targetUserId, role: 'employee' });
  if (!deletedUser) return res.status(404).json({ message: '未找到该员工账号' });

  // 同步清理该员工的所有打卡记录
  await Attendance.deleteMany({ userId: targetUserId });

  res.json({ message: `员工 [${targetUserId}] 离职/删除成功，相关打卡记录已清理。` });
});

// 获取指定员工考勤数据
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
      <div class="bg-white p-6 md:p-8 rounded-xl shadow-md w-full max-w-sm">
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
              <button type="button" onclick="togglePasswordVisibility('password', 'eyeIcon')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-gray-700">
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
            input.type = 'text';
            icon.innerText = '🙈';
          } else {
            input.type = 'password';
            icon.innerText = '👁️';
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

// 页面 2：Admin 控制台 (包含修改信息和离职/删除功能)
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
      <div class="max-w-4xl mx-auto space-y-6 md:space-y-8">
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
          <h1 class="text-2xl md:text-3xl font-bold text-gray-800">管理员控制台 (Admin)</h1>
          <button onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg w-full sm:w-auto">退出登录</button>
        </div>

        <!-- 添加员工区块 -->
        <div class="bg-white p-4 md:p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4">➕ 添加新员工</h2>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <input type="text" id="newId" placeholder="员工 ID (例如: emp01)" class="border p-2 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <input type="text" id="newName" placeholder="员工姓名" class="border p-2 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <div class="relative">
              <input type="password" id="newPass" placeholder="初始密码" class="border p-2 pr-10 rounded-lg w-full outline-none focus:ring-2 focus:ring-green-500">
              <button type="button" onclick="togglePasswordVisibility('newPass', 'eyeNew')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-gray-700">
                <span id="eyeNew">👁️</span>
              </button>
            </div>
          </div>
          <button onclick="addEmployee()" class="mt-4 w-full sm:w-auto bg-green-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-green-700 transition">添加员工</button>
        </div>

        <!-- 员工列表管理区块 -->
        <div class="bg-white p-4 md:p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4">👥 员工列表管理</h2>
          <div id="employeeList" class="grid grid-cols-1 sm:grid-cols-2 gap-4"></div>
        </div>
      </div>

      <!-- ✏️ 编辑员工信息模态框 (Modal) -->
      <div id="editModal" class="fixed inset-0 bg-black/50 hidden flex items-center justify-center p-4 z-50">
        <div class="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
          <div class="flex justify-between items-center border-b pb-3">
            <h3 class="text-lg font-bold">修改员工资料</h3>
            <button onclick="closeEditModal()" class="text-gray-400 hover:text-gray-600 font-bold">✕</button>
          </div>
          <input type="hidden" id="editOriginalUserId">
          <div>
            <label class="block text-xs text-gray-500 mb-1">员工 ID (改变ID将同步更变考勤记录)</label>
            <input type="text" id="editUserId" class="w-full border p-2 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">员工姓名</label>
            <input type="text" id="editName" class="w-full border p-2 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">新密码 (如留空则维持原密码)</label>
            <div class="relative">
              <input type="password" id="editPass" placeholder="重置新密码(可选)" class="w-full border p-2 pr-10 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
              <button type="button" onclick="togglePasswordVisibility('editPass', 'eyeEdit')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeEdit">👁️</span>
              </button>
            </div>
          </div>
          <div class="flex justify-end space-x-2 pt-2">
            <button onclick="closeEditModal()" class="px-4 py-2 border rounded-lg text-gray-600 hover:bg-gray-100">取消</button>
            <button onclick="submitEditEmployee()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold">保存更新</button>
          </div>
        </div>
      </div>

      <script>
        let cachedEmployees = [];

        function togglePasswordVisibility(inputId, eyeIconId) {
          const input = document.getElementById(inputId);
          const icon = document.getElementById(eyeIconId);
          if (input.type === 'password') {
            input.type = 'text';
            icon.innerText = '🙈';
          } else {
            input.type = 'password';
            icon.innerText = '👁️';
          }
        }

        async function init() {
          const res = await fetch('/api/me');
          const user = await res.json();
          if (!res.ok || user.role !== 'admin') location.href = '/';
          loadEmployees();
        }

        async function loadEmployees() {
          const res = await fetch('/api/admin/employees');
          cachedEmployees = await res.json();
          
          const container = document.getElementById('employeeList');
          if (cachedEmployees.length === 0) {
            container.innerHTML = '<div class="text-gray-400 col-span-2 text-center py-4">暂无员工账号</div>';
            return;
          }

          container.innerHTML = cachedEmployees.map(emp => \`
            <div class="p-4 border rounded-xl flex flex-col justify-between bg-gray-50 shadow-sm hover:shadow transition">
              <div>
                <div class="font-bold text-lg text-blue-600">\${emp.userId}</div>
                <div class="text-gray-700 font-medium">\${emp.name}</div>
              </div>
              <div class="mt-4 pt-3 border-t flex flex-wrap gap-2 text-xs">
                <button onclick="viewEmployee('\${emp.userId}')" class="bg-blue-100 text-blue-700 px-3 py-1.5 rounded-lg font-semibold hover:bg-blue-200 transition">📅 查看考勤</button>
                <button onclick="openEditModal('\${emp.userId}')" class="bg-amber-100 text-amber-800 px-3 py-1.5 rounded-lg font-semibold hover:bg-amber-200 transition">✏️ 修改资料</button>
                <button onclick="deleteEmployee('\${emp.userId}', '\${emp.name}')" class="bg-red-100 text-red-700 px-3 py-1.5 rounded-lg font-semibold hover:bg-red-200 transition">🗑️ 离职/删除</button>
              </div>
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

        function openEditModal(userId) {
          const emp = cachedEmployees.find(e => e.userId === userId);
          if (!emp) return;

          document.getElementById('editOriginalUserId').value = emp.userId;
          document.getElementById('editUserId').value = emp.userId;
          document.getElementById('editName').value = emp.name;
          document.getElementById('editPass').value = '';

          document.getElementById('editModal').classList.remove('hidden');
        }

        function closeEditModal() {
          document.getElementById('editModal').classList.add('hidden');
        }

        async function submitEditEmployee() {
          const originalUserId = document.getElementById('editOriginalUserId').value;
          const newUserId = document.getElementById('editUserId').value.trim();
          const newName = document.getElementById('editName').value.trim();
          const newPassword = document.getElementById('editPass').value.trim();

          if (!newUserId || !newName) {
            return alert('员工 ID 和姓名不能为空！');
          }

          const res = await fetch('/api/admin/update-employee', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originalUserId, newUserId, newName, newPassword })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            closeEditModal();
            loadEmployees();
          }
        }

        async function deleteEmployee(userId, name) {
          if (!confirm(\`确认要办理员工 [\${name} (\${userId})] 的离职/删除吗？\\n此操作会将该员工的账号以及所有打卡数据一同清理，无法恢复！\`)) {
            return;
          }

          const res = await fetch('/api/admin/delete-employee', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUserId: userId })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
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
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-4 md:p-6 rounded-xl shadow-sm gap-4">
          <div>
            <h1 class="text-xl md:text-2xl font-bold">员工打卡控制台</h1>
            <p class="text-gray-500 mt-1">当前查看员工 ID: <span id="dispUserId" class="font-bold text-blue-600">---</span></p>
          </div>
          <div class="space-x-2 no-print flex w-full sm:w-auto">
            <button onclick="window.print()" class="bg-gray-700 text-white px-4 py-2 rounded-lg flex-1 sm:flex-none">🖨️ 打印记录</button>
            <button id="logoutBtn" onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg flex-1 sm:flex-none">退出登录</button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div class="bg-white p-4 md:p-6 rounded-xl shadow-sm md:col-span-2">
            <h3 class="text-sm font-semibold text-gray-400 mb-2">累计考勤统计</h3>
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-blue-50 p-4 rounded-lg">
                <div class="text-gray-500 text-xs sm:text-sm">总工作时长 (已扣除休息)</div>
                <div class="text-2xl sm:text-3xl font-extrabold text-blue-600 mt-1"><span id="totalWork">0</span> 小时</div>
              </div>
              <div class="bg-orange-50 p-4 rounded-lg">
                <div class="text-gray-500 text-xs sm:text-sm">总 OT (加班时长)</div>
                <div class="text-2xl sm:text-3xl font-extrabold text-orange-600 mt-1"><span id="totalOt">0</span> 小时</div>
              </div>
            </div>
          </div>
          <div id="clockArea" class="bg-white p-4 md:p-6 rounded-xl shadow-sm flex flex-col justify-center items-center no-print">
            <button id="clockBtn" onclick="toggleClock()" class="w-full h-24 text-xl font-bold rounded-xl text-white transition bg-green-500 hover:bg-green-600">
              上班打卡 (IN)
            </button>
            <p id="clockStatus" class="text-xs text-gray-400 mt-2 text-center">点击记录当前时刻</p>
          </div>
        </div>

        <!-- 📝 补录与修改区域 -->
        <div id="manualArea" class="bg-white p-4 md:p-6 rounded-xl shadow-sm no-print">
          <h3 id="formTitle" class="text-lg font-bold mb-4">添加/修改打卡记录</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
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
        <div class="bg-white p-4 md:p-6 rounded-xl shadow-sm overflow-x-auto">
          <h3 class="text-lg font-bold mb-4">打卡历史记录</h3>
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
      </div>

      <script>
        const urlParams = new URLSearchParams(window.location.search);
        const viewUserId = urlParams.get('viewUserId');
        let currentUser = null;
        let targetUserId = '';
        let pickerIn, pickerOut, pickerDate;

        function initTimePickers() {
          pickerDate = flatpickr("#mDate", { dateFormat: "Y-m-d" });
          pickerIn = flatpickr("#mIn", {
            enableTime: true,
            noCalendar: true,
            dateFormat: "H:i",
            time_24hr: true
          });
          pickerOut = flatpickr("#mOut", {
            enableTime: true,
            noCalendar: true,
            dateFormat: "H:i",
            time_24hr: true
          });
        }

        function formatTo24HourTime(dateIsoStr) {
          if (!dateIsoStr) return '';
          const d = new Date(dateIsoStr);
          if (isNaN(d.getTime())) return '';
          
          return d.toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Kuala_Lumpur'
          });
        }

        async function init() {
          initTimePickers();
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
              status.innerText = \`已签到：\${formatTo24HourTime(data.todayRecord.clockIn)}\`;
            } else {
              btn.innerText = "今日打卡完成";
              btn.disabled = true;
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-gray-400 cursor-not-allowed";
              status.innerText = "明日跨天后可再次打卡";
            }
          }

          const table = document.getElementById('historyTable');
          table.innerHTML = data.history.map(row => {
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

        function editRow(date, clockIn, clockOut) {
          pickerDate.setDate(date);
          pickerIn.setDate(clockIn);
          pickerOut.setDate(clockOut);
          
          const targetArea = document.getElementById('manualArea');
          targetArea.scrollIntoView({ behavior: 'smooth' });
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
          if (res.ok) {
            loadAttendanceData();
          }
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
            pickerDate.clear();
            pickerIn.clear();
            pickerOut.clear();
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务已启动，监听所有网络接口，端口: ${PORT}`);
});
