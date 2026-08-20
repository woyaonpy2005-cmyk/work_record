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
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
  status: { type: String, enum: ['active', 'resigned'], default: 'active' } // 新增：离职/在职状态
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
        role: 'admin',
        status: 'active'
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

// 辅助函数：获取当前月份 YYYY-MM
const getCurrentMonthStr = () => {
  return getTodayStr().substring(0, 7);
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

  if (user.status === 'resigned') {
    return res.status(403).json({ message: '该员工账号已标记为离职，无法登录系统' });
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).json({ message: '密码错误' });

  req.session.user = { userId: user.userId, role: user.role, name: user.name, status: user.status };
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
  if (!userId || !password || !name) return res.status(400).json({ message: '请填写完整信息' });

  const exists = await User.findOne({ userId });
  if (exists) return res.status(400).json({ message: '员工ID已存在' });

  const hashedPassword = await bcrypt.hash(password, 10);
  await User.create({ userId, password: hashedPassword, name, role: 'employee', status: 'active' });
  res.json({ message: '员工添加成功' });
});

// Admin API：获取所有员工列表
app.get('/api/admin/employees', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const employees = await User.find({ role: 'employee' }, 'userId name status');
  res.json(employees);
});

// Admin API：编辑员工信息 (包含修改 ID, 姓名, 密码)
app.post('/api/admin/update-employee', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { originalUserId, newUserId, name, newPassword } = req.body;
  if (!originalUserId || !newUserId || !name) {
    return res.status(400).json({ message: '请填写完整基本信息' });
  }

  const user = await User.findOne({ userId: originalUserId });
  if (!user) return res.status(404).json({ message: '找不到该员工' });

  // 如果修改了 ID，要确保新 ID 没有重名
  if (originalUserId !== newUserId) {
    const exists = await User.findOne({ userId: newUserId });
    if (exists) return res.status(400).json({ message: '新员工ID已被使用' });
    
    // 同步更新打卡历史中的 userId
    await Attendance.updateMany({ userId: originalUserId }, { userId: newUserId });
    user.userId = newUserId;
  }

  user.name = name;

  if (newPassword && newPassword.trim() !== '') {
    user.password = await bcrypt.hash(newPassword, 10);
  }

  await user.save();
  res.json({ message: '员工信息更新成功！' });
});

// Admin API：切换员工在职/离职状态
app.post('/api/admin/toggle-status', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { targetUserId, status } = req.body;
  if (!targetUserId || !['active', 'resigned'].includes(status)) {
    return res.status(400).json({ message: '参数有误' });
  }

  const updatedUser = await User.findOneAndUpdate({ userId: targetUserId }, { status }, { new: true });
  if (!updatedUser) return res.status(404).json({ message: '找不到该员工' });

  res.json({ message: `员工状态已更改为：${status === 'resigned' ? '已离职' : '在职'}` });
});

// Admin API：彻底删除员工及其考勤记录
app.delete('/api/admin/delete-employee', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ message: '参数缺失' });

  const deletedUser = await User.findOneAndDelete({ userId: targetUserId });
  if (!deletedUser) return res.status(404).json({ message: '员工不存在' });

  // 彻底删除该员工的所有打卡记录
  await Attendance.deleteMany({ userId: targetUserId });

  res.json({ message: `员工 ${targetUserId} 及其所有考勤记录已成功删除` });
});

// 获取指定员工考勤数据（支持月份筛选 YYYY-MM）
app.get('/api/attendance/:targetUserId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录' });
  
  const targetUserId = req.params.targetUserId;
  const month = req.query.month || getCurrentMonthStr(); // 默认当月
  const today = getTodayStr();

  const monthRegex = new RegExp(`^${month}`);

  let todayRecord = await Attendance.findOne({ userId: targetUserId, date: today });
  
  // 查询指定月份的打卡历史
  const history = await Attendance.find({ userId: targetUserId, date: monthRegex }).sort({ date: -1 });

  const totals = history.reduce((acc, item) => {
    acc.totalWork += item.workHours || 0;
    acc.totalOt += item.otHours || 0;
    return acc;
  }, { totalWork: 0, totalOt: 0 });

  res.json({
    todayRecord,
    history,
    selectedMonth: month,
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

// 页面 1：登录界面 (响应式移动端优化)
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
      <div class="bg-white p-6 sm:p-8 rounded-xl shadow-md w-full max-w-md">
        <h2 class="text-2xl font-bold mb-6 text-center text-gray-800">员工考勤系统登录</h2>
        <div id="errorMsg" class="text-red-500 text-sm mb-4 hidden text-center bg-red-50 p-2 rounded"></div>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">账号 / 员工ID</label>
            <input type="text" id="userId" placeholder="输入员工号" class="w-full border rounded-lg p-2.5 focus:ring-2 focus:ring-blue-500 outline-none text-base">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <div class="relative">
              <input type="password" id="password" placeholder="输入密码" class="w-full border rounded-lg p-2.5 pr-10 focus:ring-2 focus:ring-blue-500 outline-none text-base">
              <button type="button" onclick="togglePasswordVisibility('password', 'eyeIcon')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-gray-700">
                <span id="eyeIcon">👁️</span>
              </button>
            </div>
          </div>
          <button onclick="login()" class="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition active:scale-95 text-base">登录</button>
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
          const userId = document.getElementById('userId').value.trim();
          const password = document.getElementById('password').value.trim();
          const errorMsg = document.getElementById('errorMsg');
          errorMsg.classList.add('hidden');

          if (!userId || !password) {
            errorMsg.innerText = '请填写入所有的输入框';
            errorMsg.classList.remove('hidden');
            return;
          }

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

// 页面 2：Admin 控制台 (包含支持删除员工、修改姓名/ID/密码、标记离职/在职)
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
    <body class="bg-gray-50 min-h-screen p-4 sm:p-8">
      <div class="max-w-4xl mx-auto space-y-6">
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-6 rounded-xl shadow-sm">
          <h1 class="text-2xl sm:text-3xl font-bold text-gray-800">管理员控制台 (Admin)</h1>
          <button onclick="logout()" class="w-full sm:w-auto bg-red-500 text-white px-5 py-2 rounded-lg hover:bg-red-600 transition">退出登录</button>
        </div>

        <!-- 添加新员工 -->
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4 text-gray-800">➕ 添加新员工</h2>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs text-gray-500 mb-1">员工 ID</label>
              <input type="text" id="newId" placeholder="例如: emp01" class="w-full border p-2.5 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">员工姓名</label>
              <input type="text" id="newName" placeholder="员工姓名" class="w-full border p-2.5 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">初始密码</label>
              <div class="relative">
                <input type="password" id="newPass" placeholder="初始密码" class="w-full border p-2.5 pr-10 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
                <button type="button" onclick="togglePasswordVisibility('newPass', 'eyeNew')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                  <span id="eyeNew">👁️</span>
                </button>
              </div>
            </div>
          </div>
          <button onclick="addEmployee()" class="mt-4 w-full sm:w-auto bg-green-600 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-green-700 transition">添加员工</button>
        </div>

        <!-- 员工列表管理 -->
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4 text-gray-800">👥 员工管理列表</h2>
          <div id="employeeList" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
        </div>
      </div>

      <!-- 修改员工 Modal 弹窗 -->
      <div id="editModal" class="fixed inset-0 bg-black/50 backdrop-blur-sm hidden flex items-center justify-center p-4 z-50">
        <div class="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
          <div class="flex justify-between items-center border-b pb-3">
            <h3 class="text-lg font-bold text-gray-800">✏️ 编辑员工信息</h3>
            <button onclick="closeEditModal()" class="text-gray-400 hover:text-gray-600 text-xl font-bold">&times;</button>
          </div>
          <input type="hidden" id="editOriginalId">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">员工 ID</label>
            <input type="text" id="editUserId" class="w-full border p-2 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">姓名</label>
            <input type="text" id="editName" class="w-full border p-2 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">新密码 (不改请留空)</label>
            <div class="relative">
              <input type="password" id="editPassword" placeholder="留空保持原密码" class="w-full border p-2 pr-10 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
              <button type="button" onclick="togglePasswordVisibility('editPassword', 'eyeEdit')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeEdit">👁️</span>
              </button>
            </div>
          </div>
          <div class="flex gap-3 pt-2">
            <button onclick="closeEditModal()" class="w-1/2 border py-2 rounded-lg text-gray-600 hover:bg-gray-50">取消</button>
            <button onclick="saveEmployeeEdit()" class="w-1/2 bg-blue-600 text-white py-2 rounded-lg font-semibold hover:bg-blue-700">保存修改</button>
          </div>
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
          if (list.length === 0) {
            container.innerHTML = `<div class="col-span-full text-center py-6 text-gray-400">暂无员工，请添加</div>`;
            return;
          }

          container.innerHTML = list.map(emp => {
            const isResigned = emp.status === 'resigned';
            return `
              <div class="p-4 border rounded-xl flex flex-col justify-between bg-white shadow-xs ${isResigned ? 'opacity-60 bg-gray-50' : ''}">
                <div>
                  <div class="flex justify-between items-start mb-2">
                    <div>
                      <span class="font-bold text-lg text-blue-600">${emp.userId}</span>
                      <span class="ml-2 font-semibold text-gray-800">${emp.name}</span>
                    </div>
                    <span class="px-2 py-0.5 text-xs font-semibold rounded-full ${isResigned ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}">
                      ${isResigned ? '已离职' : '在职'}
                    </span>
                  </div>
                </div>

                <div class="mt-4 pt-3 border-t flex flex-wrap gap-2 text-xs">
                  <button onclick="viewEmployee('${emp.userId}')" class="bg-blue-50 text-blue-600 border border-blue-200 px-2.5 py-1.5 rounded-lg font-medium hover:bg-blue-100 transition">📅 查看打卡</button>
                  <button onclick="openEditModal('${emp.userId}', '${emp.name}')" class="bg-amber-50 text-amber-700 border border-amber-200 px-2.5 py-1.5 rounded-lg font-medium hover:bg-amber-100 transition">✏️ 修改</button>
                  <button onclick="toggleResignedStatus('${emp.userId}', '${isResigned ? 'active' : 'resigned'}')" class="${isResigned ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'} border px-2.5 py-1.5 rounded-lg font-medium transition">
                    ${isResigned ? '🟢 设为在职' : '🚫 设为离职'}
                  </button>
                  <button onclick="deleteEmployee('${emp.userId}')" class="bg-red-50 text-red-600 border border-red-200 px-2.5 py-1.5 rounded-lg font-medium hover:bg-red-100 transition ml-auto">🗑️ 删除</button>
                </div>
              </div>
            `;
          }).join('');
        }

        async function addEmployee() {
          const userId = document.getElementById('newId').value.trim();
          const name = document.getElementById('newName').value.trim();
          const password = document.getElementById('newPass').value.trim();
          
          if(!userId || !name || !password) return alert('请填写完整的员工信息！');

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
          document.getElementById('editOriginalId').value = userId;
          document.getElementById('editUserId').value = userId;
          document.getElementById('editName').value = name;
          document.getElementById('editPassword').value = '';
          document.getElementById('editModal').classList.remove('hidden');
        }

        function closeEditModal() {
          document.getElementById('editModal').classList.add('hidden');
        }

        async function saveEmployeeEdit() {
          const originalUserId = document.getElementById('editOriginalId').value;
          const newUserId = document.getElementById('editUserId').value.trim();
          const name = document.getElementById('editName').value.trim();
          const newPassword = document.getElementById('editPassword').value.trim();

          if (!newUserId || !name) return alert('员工ID和姓名不能为空');

          const res = await fetch('/api/admin/update-employee', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ originalUserId, newUserId, name, newPassword })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            closeEditModal();
            loadEmployees();
          }
        }

        async function toggleResignedStatus(targetUserId, status) {
          const actionText = status === 'resigned' ? '标记为已离职' : '重新恢复为在职';
          if (!confirm(`确定要将员工 ${targetUserId} ${actionText} 吗？`)) return;

          const res = await fetch('/api/admin/toggle-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUserId, status })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) loadEmployees();
        }

        async function deleteEmployee(targetUserId) {
          if (!confirm(`⚠️ 确定要彻底删除员工 ${targetUserId} 吗？\n警告：该员工的所有打卡记录都将被彻底清空！`)) return;

          const res = await fetch('/api/admin/delete-employee', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUserId })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) loadEmployees();
        }

        function viewEmployee(userId) {
          location.href = `/employee?viewUserId=${userId}`;
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

// 页面 3：员工打卡/修改打卡页 (新增：月份筛选，默认7天显示+点击查看更多，全移动端适配)
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
    <body class="bg-gray-50 min-h-screen p-3 sm:p-8">
      <div class="max-w-4xl mx-auto space-y-4 sm:space-y-6">
        
        <!-- Header 头部栏 -->
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-5 rounded-xl shadow-sm gap-4">
          <div>
            <h1 class="text-xl sm:text-2xl font-bold text-gray-800">员工打卡控制台</h1>
            <p class="text-sm text-gray-500 mt-1">当前查看员工 ID: <span id="dispUserId" class="font-bold text-blue-600">---</span></p>
          </div>
          <div class="flex items-center gap-2 w-full sm:w-auto no-print">
            <button onclick="window.print()" class="flex-1 sm:flex-none bg-gray-700 text-white px-3 sm:px-4 py-2 rounded-lg text-sm hover:bg-gray-800 transition">🖨️ 打印记录</button>
            <button id="logoutBtn" onclick="logout()" class="flex-1 sm:flex-none bg-red-500 text-white px-3 sm:px-4 py-2 rounded-lg text-sm hover:bg-red-600 transition">退出登录</button>
          </div>
        </div>

        <!-- 打卡状态 & 统计卡片 -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
          <div class="bg-white p-5 rounded-xl shadow-sm md:col-span-2">
            <div class="flex justify-between items-center mb-3">
              <h3 class="text-sm font-semibold text-gray-500">考勤工时统计</h3>
              <!-- 月份选择器 -->
              <div class="flex items-center gap-2">
                <label for="monthPicker" class="text-xs text-gray-500">月份:</label>
                <input type="month" id="monthPicker" onchange="onMonthChange()" class="border text-xs sm:text-sm p-1.5 rounded-lg bg-gray-50 outline-none focus:ring-2 focus:ring-blue-500">
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3 sm:gap-4">
              <div class="bg-blue-50 p-3 sm:p-4 rounded-lg">
                <div class="text-gray-500 text-xs sm:text-sm">当月工时 (扣除休息)</div>
                <div class="text-xl sm:text-3xl font-extrabold text-blue-600 mt-1"><span id="totalWork">0</span> <span class="text-xs sm:text-base font-normal">小时</span></div>
              </div>
              <div class="bg-orange-50 p-3 sm:p-4 rounded-lg">
                <div class="text-gray-500 text-xs sm:text-sm">当月 OT 加班</div>
                <div class="text-xl sm:text-3xl font-extrabold text-orange-600 mt-1"><span id="totalOt">0</span> <span class="text-xs sm:text-base font-normal">小时</span></div>
              </div>
            </div>
          </div>

          <div id="clockArea" class="bg-white p-5 rounded-xl shadow-sm flex flex-col justify-center items-center no-print">
            <button id="clockBtn" onclick="toggleClock()" class="w-full h-20 sm:h-24 text-lg sm:text-xl font-bold rounded-xl text-white transition bg-green-500 hover:bg-green-600 active:scale-95 shadow-md">
              上班打卡 (IN)
            </button>
            <p id="clockStatus" class="text-xs text-gray-400 mt-2 text-center">点击记录当前时刻</p>
          </div>
        </div>

        <!-- 📝 补录与修改区域 -->
        <div id="manualArea" class="bg-white p-5 rounded-xl shadow-sm no-print">
          <h3 id="formTitle" class="text-base sm:text-lg font-bold mb-3 text-gray-800">添加/修改打卡记录</h3>
          <div class="grid grid-cols-1 sm:grid-cols-4 gap-3 sm:gap-4">
            <div>
              <label class="text-xs text-gray-400">选择日期</label>
              <input type="text" id="mDate" placeholder="选择日期" class="border p-2 rounded-lg w-full bg-white cursor-pointer text-sm">
            </div>
            <div>
              <label class="text-xs text-gray-400">上班时间 (24小时制)</label>
              <input type="text" id="mIn" placeholder="选择上班时间" class="border p-2 rounded-lg w-full bg-white cursor-pointer text-sm">
            </div>
            <div>
              <label class="text-xs text-gray-400">下班时间 (24小时制)</label>
              <input type="text" id="mOut" placeholder="选择下班时间" class="border p-2 rounded-lg w-full bg-white cursor-pointer text-sm">
            </div>
            <div class="flex items-end">
              <button onclick="addManualRecord()" class="bg-indigo-600 text-white w-full py-2 sm:py-2.5 rounded-lg font-semibold hover:bg-indigo-700 transition text-sm">保存记录</button>
            </div>
          </div>
        </div>

        <!-- 历史记录表格 (响应式 + 查看更多) -->
        <div class="bg-white p-5 rounded-xl shadow-sm">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-base sm:text-lg font-bold text-gray-800">打卡历史记录</h3>
            <span id="recordCountText" class="text-xs text-gray-400"></span>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[600px]">
              <thead>
                <tr class="border-b bg-gray-50 text-gray-600 text-xs sm:text-sm">
                  <th class="p-2.5 sm:p-3">日期</th>
                  <th class="p-2.5 sm:p-3">上班打卡</th>
                  <th class="p-2.5 sm:p-3">下班打卡</th>
                  <th class="p-2.5 sm:p-3">实际工时</th>
                  <th class="p-2.5 sm:p-3">OT 时长</th>
                  <th class="p-2.5 sm:p-3">类型</th>
                  <th class="p-2.5 sm:p-3 no-print">操作</th>
                </tr>
              </thead>
              <tbody id="historyTable" class="divide-y text-xs sm:text-sm"></tbody>
            </table>
          </div>

          <!-- 点击查看更多按钮 -->
          <div id="loadMoreArea" class="mt-4 text-center hidden">
            <button onclick="showAllRecords()" class="bg-gray-100 hover:bg-gray-200 text-gray-700 px-6 py-2 rounded-lg text-sm font-medium transition inline-flex items-center gap-1">
              ▼ 点击查看更多历史记录 (剩余 <span id="remainingCount">0</span> 条)
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

        let fullHistoryRecords = []; // 存储当前月完整记录
        let isShowingAll = false; // 是否展示全部记录

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

        // 初始化默认月份 (YYYY-MM)
        function setDefaultMonth() {
          const now = new Date();
          const year = now.getFullYear();
          const month = String(now.getMonth() + 1).padStart(2, '0');
          document.getElementById('monthPicker').value = `${year}-${month}`;
        }

        async function init() {
          setDefaultMonth();
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

        function onMonthChange() {
          isShowingAll = false; // 重新重置为优先显示前7天
          loadAttendanceData();
        }

        async function loadAttendanceData() {
          const selectedMonth = document.getElementById('monthPicker').value;
          const res = await fetch(`/api/attendance/${targetUserId}?month=${selectedMonth}`);
          const data = await res.json();
          
          document.getElementById('totalWork').innerText = data.totalWorkHours;
          document.getElementById('totalOt').innerText = data.totalOtHours;

          if (currentUser.role === 'employee') {
            const btn = document.getElementById('clockBtn');
            const status = document.getElementById('clockStatus');
            if (!data.todayRecord || !data.todayRecord.clockIn) {
              btn.innerText = "上班打卡 (IN)";
              btn.className = "w-full h-20 sm:h-24 text-lg sm:text-xl font-bold rounded-xl text-white bg-green-500 hover:bg-green-600 transition shadow-md";
              status.innerText = "状态：未打卡";
            } else if (data.todayRecord.clockIn && !data.todayRecord.clockOut) {
              btn.innerText = "下班打卡 (OUT)";
              btn.className = "w-full h-20 sm:h-24 text-lg sm:text-xl font-bold rounded-xl text-white bg-red-500 hover:bg-red-600 transition shadow-md";
              status.innerText = `已签到：${formatTo24HourTime(data.todayRecord.clockIn)}`;
            } else {
              btn.innerText = "今日打卡完成";
              btn.disabled = true;
              btn.className = "w-full h-20 sm:h-24 text-lg sm:text-xl font-bold rounded-xl text-white bg-gray-400 cursor-not-allowed";
              status.innerText = "明日跨天后可再次打卡";
            }
          }

          fullHistoryRecords = data.history || [];
          renderHistoryTable();
        }

        function renderHistoryTable() {
          const table = document.getElementById('historyTable');
          const loadMoreArea = document.getElementById('loadMoreArea');
          const remainingCountSpan = document.getElementById('remainingCount');
          const recordCountText = document.getElementById('recordCountText');

          if (fullHistoryRecords.length === 0) {
            table.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-gray-400">当前月份暂无打卡记录</td></tr>`;
            loadMoreArea.classList.add('hidden');
            recordCountText.innerText = `共 0 条记录`;
            return;
          }

          const displayRecords = isShowingAll ? fullHistoryRecords : fullHistoryRecords.slice(0, 7);

          table.innerHTML = displayRecords.map(row => {
            const inTime24 = formatTo24HourTime(row.clockIn);
            const outTime24 = formatTo24HourTime(row.clockOut);
            
            return `
              <tr>
                <td class="p-2.5 sm:p-3 font-medium text-gray-900">${row.date}</td>
                <td class="p-2.5 sm:p-3">${inTime24 || '-'}</td>
                <td class="p-2.5 sm:p-3">${outTime24 || '-'}</td>
                <td class="p-2.5 sm:p-3 font-semibold text-blue-600">${row.workHours} 小时</td>
                <td class="p-2.5 sm:p-3 font-semibold text-orange-600">${row.otHours} 小时</td>
                <td class="p-2.5 sm:p-3"><span class="px-2 py-0.5 text-xs rounded ${row.isManual ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}">${row.isManual ? '手动补录/修改' : '实时打卡'}</span></td>
                <td class="p-2.5 sm:p-3 no-print space-x-1 sm:space-x-2 whitespace-nowrap">
                  <button onclick="editRow('${row.date}', '${inTime24}', '${outTime24}')" class="text-indigo-600 hover:text-indigo-900 font-semibold text-xs border border-indigo-200 px-2 py-1 rounded hover:bg-indigo-50 transition">✏️ 修改</button>
                  <button onclick="deleteRow('${row.date}')" class="text-red-600 hover:text-red-900 font-semibold text-xs border border-red-200 px-2 py-1 rounded hover:bg-red-50 transition">🗑️ 删除</button>
                </td>
              </tr>
            `;
          }).join('');

          // 判断是否需要显示“点击查看更多”
          if (!isShowingAll && fullHistoryRecords.length > 7) {
            const remaining = fullHistoryRecords.length - 7;
            remainingCountSpan.innerText = remaining;
            loadMoreArea.classList.remove('hidden');
            recordCountText.innerText = `目前展示前 7 天 (共 ${fullHistoryRecords.length} 条记录)`;
          } else {
            loadMoreArea.classList.add('hidden');
            recordCountText.innerText = `共 ${fullHistoryRecords.length} 条记录`;
          }
        }

        function showAllRecords() {
          isShowingAll = true;
          renderHistoryTable();
        }

        function editRow(date, clockIn, clockOut) {
          pickerDate.setDate(date);
          pickerIn.setDate(clockIn);
          pickerOut.setDate(clockOut);
          
          const targetArea = document.getElementById('manualArea');
          targetArea.scrollIntoView({ behavior: 'smooth' });
        }

        async function deleteRow(date) {
          if (!confirm(`确定要删除 ${date} 的打卡记录吗？`)) return;

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

app.listen(PORT, () => {
  console.log(`🚀 服务已启动，监听端口: ${PORT}`);
});
