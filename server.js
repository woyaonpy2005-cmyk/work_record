const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// 时区配置
const TIMEZONE_OFFSET = '+08:00'; 
const TIMEZONE_NAME = 'Asia/Kuala_Lumpur';

// 数据库连接字符串
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://woyaonpy2005_db_user:Lim050831.@cluster0.ztvp8bb.mongodb.net/attendance_db?appName=Cluster0";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session 配置（持久化存储到 MongoDB）
app.use(session({
  secret: 'attendance_secret_key_123',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 天有效
}));

// ==================== 1. 数据库模型定义 ====================
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
  status: { type: String, enum: ['active', 'resigned'], default: 'active' } // 新增：在职/离职状态
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
attendanceSchema.index({ userId: 1, date: 1 });
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

// 辅助函数
const getTodayStr = () => {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE_NAME });
};

const getCurrentMonthStr = () => {
  const today = getTodayStr();
  return today.substring(0, 7); // YYYY-MM
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

// 中间件：身份验证
const authMiddleware = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录或登录已超时' });
  next();
};

const adminMiddleware = (req, res, next) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作，仅限管理员' });
  }
  next();
};

// ==================== 2. API 路由 ====================

// 登录 API
app.post('/api/login', async (req, res) => {
  try {
    const { userId, password } = req.body;
    const user = await User.findOne({ userId });
    if (!user) return res.status(400).json({ message: '账号不存在' });

    if (user.status === 'resigned') {
      return res.status(403).json({ message: '该账号已标记为离职，无法登录系统' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: '密码错误' });

    req.session.user = { userId: user.userId, role: user.role, name: user.name };
    res.json({ role: user.role, userId: user.userId });
  } catch (e) {
    res.status(500).json({ message: '服务器错误: ' + e.message });
  }
});

// 获取当前登录人
app.get('/api/me', authMiddleware, (req, res) => {
  res.json(req.session.user);
});

// 退出登录
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Admin API：添加员工
app.post('/api/admin/add-employee', adminMiddleware, async (req, res) => {
  try {
    const { userId, password, name } = req.body;
    if (!userId || !password || !name) return res.status(400).json({ message: '请填写所有必需参数' });

    const exists = await User.findOne({ userId });
    if (exists) return res.status(400).json({ message: '员工 ID 已存在' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ userId, password: hashedPassword, name, role: 'employee', status: 'active' });
    res.json({ message: '员工添加成功' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Admin API：获取所有员工列表（包含离职状态）
app.get('/api/admin/employees', adminMiddleware, async (req, res) => {
  try {
    const employees = await User.find({ role: 'employee' }, 'userId name status');
    res.json(employees);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Admin API：更新员工完整信息 (姓名、ID、密码)
app.put('/api/admin/update-employee', adminMiddleware, async (req, res) => {
  try {
    const { oldUserId, newUserId, name, password } = req.body;
    if (!oldUserId || !newUserId || !name) {
      return res.status(400).json({ message: '缺少关键参数' });
    }

    const user = await User.findOne({ userId: oldUserId });
    if (!user) return res.status(404).json({ message: '未找到该员工' });

    // 若修改了 ID，检查新 ID 是否重复
    if (oldUserId !== newUserId) {
      const exists = await User.findOne({ userId: newUserId });
      if (exists) return res.status(400).json({ message: '新的员工 ID 已被占用' });
      
      // 同步更新打卡历史记录里的 userId
      await Attendance.updateMany({ userId: oldUserId }, { userId: newUserId });
    }

    user.userId = newUserId;
    user.name = name;
    if (password && password.trim() !== '') {
      user.password = await bcrypt.hash(password, 10);
    }
    await user.save();

    res.json({ message: '员工信息更新成功！' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Admin API：切换员工离职/在职状态
app.put('/api/admin/toggle-status', adminMiddleware, async (req, res) => {
  try {
    const { targetUserId, status } = req.body;
    if (!['active', 'resigned'].includes(status)) {
      return res.status(400).json({ message: '状态值无效' });
    }

    const user = await User.findOneAndUpdate({ userId: targetUserId }, { status }, { new: true });
    if (!user) return res.status(404).json({ message: '未找到员工' });

    res.json({ message: `员工 ${targetUserId} 状态已更新为：${status === 'resigned' ? '已离职' : '在职'}` });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Admin API：彻底删除员工
app.delete('/api/admin/delete-employee', adminMiddleware, async (req, res) => {
  try {
    const { targetUserId } = req.body;
    const deletedUser = await User.findOneAndDelete({ userId: targetUserId, role: 'employee' });
    if (!deletedUser) return res.status(404).json({ message: '未找到要删除的员工' });

    // 可选：删除关联的打卡数据
    await Attendance.deleteMany({ userId: targetUserId });

    res.json({ message: `员工 ${targetUserId} 及其考勤数据已被彻底删除！` });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// 获取指定员工考勤数据 (按月份筛选)
app.get('/api/attendance/:targetUserId', authMiddleware, async (req, res) => {
  try {
    const targetUserId = req.params.targetUserId;
    const month = req.query.month || getCurrentMonthStr(); // YYYY-MM
    const today = getTodayStr();

    let todayRecord = await Attendance.findOne({ userId: targetUserId, date: today });
    
    // 按月份正则匹配查询 (例如 ^2026-08)
    const monthRegex = new RegExp(`^${month}`);
    const history = await Attendance.find({ 
      userId: targetUserId, 
      date: { $regex: monthRegex } 
    }).sort({ date: -1 });

    const totals = history.reduce((acc, item) => {
      acc.totalWork += item.workHours || 0;
      acc.totalOt += item.otHours || 0;
      return acc;
    }, { totalWork: 0, totalOt: 0 });

    res.json({
      todayRecord,
      history,
      currentMonth: month,
      totalWorkHours: parseFloat(totals.totalWork.toFixed(2)),
      totalOtHours: parseFloat(totals.totalOt.toFixed(2))
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// 实时 Toggle 打卡 API
app.post('/api/attendance/toggle', authMiddleware, async (req, res) => {
  try {
    const user = req.session.user;
    if (user.role !== 'employee') return res.status(403).json({ message: '仅员工能进行此操作' });

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
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// 手动添加/修改记录 API
app.post('/api/attendance/manual', authMiddleware, async (req, res) => {
  try {
    const user = req.session.user;
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
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// 删除打卡记录 API
app.delete('/api/attendance/delete', authMiddleware, async (req, res) => {
  try {
    const user = req.session.user;
    const { date, targetUserId } = req.body;
    if (!date) return res.status(400).json({ message: '缺少参数：日期' });

    const deleteUserId = (user.role === 'admin' && targetUserId) ? targetUserId : user.userId;

    const deleted = await Attendance.findOneAndDelete({ userId: deleteUserId, date });
    if (!deleted) return res.status(404).json({ message: '未找到该日期的打卡记录' });

    res.json({ message: '记录已成功删除！' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
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
      <div class="bg-white p-6 sm:p-8 rounded-xl shadow-md w-full max-w-md">
        <h2 class="text-2xl font-bold mb-6 text-center text-gray-800">员工考勤系统登录</h2>
        <div id="errorMsg" class="text-red-500 text-sm mb-4 hidden text-center bg-red-50 p-2 rounded"></div>
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700">账号 / 员工ID</label>
            <input type="text" id="userId" class="mt-1 w-full border rounded-lg p-2.5 focus:ring-2 focus:ring-blue-500 outline-none">
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700">密码</label>
            <div class="relative mt-1">
              <input type="password" id="password" class="w-full border rounded-lg p-2.5 pr-10 focus:ring-2 focus:ring-blue-500 outline-none">
              <button type="button" onclick="togglePasswordVisibility('password', 'eyeIcon')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeIcon">👁️</span>
              </button>
            </div>
          </div>
          <button onclick="login()" class="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold hover:bg-blue-700 transition">登录</button>
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

          if(!userId || !password) {
            errorMsg.innerText = "请填入完整的账号和密码";
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
    <body class="bg-gray-50 min-h-screen p-4 sm:p-8">
      <div class="max-w-5xl mx-auto space-y-6">
        <div class="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 bg-white p-6 rounded-xl shadow-sm">
          <h1 class="text-2xl sm:text-3xl font-bold text-gray-800">👑 管理员控制台</h1>
          <button onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600 transition self-start sm:self-auto">退出登录</button>
        </div>

        <!-- 添加员工 -->
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4">➕ 添加新员工</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input type="text" id="newId" placeholder="员工 ID (例: emp01)" class="border p-2.5 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <input type="text" id="newName" placeholder="员工姓名" class="border p-2.5 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <div class="relative">
              <input type="password" id="newPass" placeholder="初始密码" class="border p-2.5 pr-10 rounded-lg w-full outline-none focus:ring-2 focus:ring-green-500">
              <button type="button" onclick="togglePasswordVisibility('newPass', 'eyeNew')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeNew">👁️</span>
              </button>
            </div>
          </div>
          <button onclick="addEmployee()" class="mt-4 w-full sm:w-auto bg-green-600 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-green-700 transition">确认添加</button>
        </div>

        <!-- 员工列表 -->
        <div class="bg-white p-6 rounded-xl shadow-sm">
          <h2 class="text-xl font-bold mb-4">👥 员工管理列表</h2>
          <div id="employeeList" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
        </div>
      </div>

      <!-- 编辑员工 Modal 弹窗 -->
      <div id="editModal" class="fixed inset-0 bg-black/50 hidden flex items-center justify-center p-4 z-50">
        <div class="bg-white rounded-xl max-w-md w-full p-6 space-y-4">
          <h3 class="text-xl font-bold text-gray-800">✏️ 修改员工信息</h3>
          <input type="hidden" id="editOldUserId">
          <div>
            <label class="text-xs text-gray-500">员工 ID</label>
            <input type="text" id="editUserId" class="w-full border p-2 rounded-lg mt-1 outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="text-xs text-gray-500">员工姓名</label>
            <input type="text" id="editName" class="w-full border p-2 rounded-lg mt-1 outline-none focus:ring-2 focus:ring-blue-500">
          </div>
          <div>
            <label class="text-xs text-gray-500">新密码（留空则不修改密码）</label>
            <div class="relative mt-1">
              <input type="password" id="editPassword" placeholder="填写新密码" class="w-full border p-2 pr-10 rounded-lg outline-none focus:ring-2 focus:ring-blue-500">
              <button type="button" onclick="togglePasswordVisibility('editPassword', 'eyeEdit')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">
                <span id="eyeEdit">👁️</span>
              </button>
            </div>
          </div>
          <div class="flex justify-end space-x-3 pt-4 border-t">
            <button onclick="closeEditModal()" class="px-4 py-2 border rounded-lg text-gray-600 hover:bg-gray-100">取消</button>
            <button onclick="saveEmployeeEdit()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">保存修改</button>
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
          container.innerHTML = list.map(emp => {
            const isResigned = emp.status === 'resigned';
            return \`
              <div class="p-4 border rounded-xl bg-gray-50 flex flex-col justify-between space-y-3 \${isResigned ? 'opacity-60 bg-gray-200' : ''}">
                <div class="flex justify-between items-start">
                  <div>
                    <span class="font-bold text-lg text-blue-600">\${emp.userId}</span>
                    \${isResigned ? '<span class="ml-2 text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded font-semibold">已离职</span>' : '<span class="ml-2 text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded font-semibold">在职</span>'}
                    <div class="text-gray-700 font-medium text-base mt-1">\${emp.name}</div>
                  </div>
                  <button onclick="viewEmployee('\${emp.userId}')" class="text-xs bg-blue-500 text-white px-3 py-1.5 rounded-lg hover:bg-blue-600">查看打卡</button>
                </div>
                
                <div class="flex flex-wrap gap-2 pt-2 border-t text-xs">
                  <button onclick="openEditModal('\${emp.userId}', '\${emp.name}')" class="bg-amber-500 text-white px-2.5 py-1.5 rounded hover:bg-amber-600">✏️ 修改信息</button>
                  <button onclick="toggleResignStatus('\${emp.userId}', '\${isResigned ? 'active' : 'resigned'}')" class="\${isResigned ? 'bg-green-600' : 'bg-orange-500'} text-white px-2.5 py-1.5 rounded hover:opacity-90">
                    \${isResigned ? '🔄 设为在职' : '🚫 标记离职'}
                  </button>
                  <button onclick="deleteEmployee('\${emp.userId}')" class="bg-red-600 text-white px-2.5 py-1.5 rounded hover:bg-red-700">🗑️ 删除员工</button>
                </div>
              </div>
            \`;
          }).join('');
        }

        async function addEmployee() {
          const userId = document.getElementById('newId').value.trim();
          const name = document.getElementById('newName').value.trim();
          const password = document.getElementById('newPass').value.trim();
          
          if (!userId || !name || !password) return alert('请填入所有必需信息！');

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
          document.getElementById('editPassword').value = '';
          document.getElementById('editModal').classList.remove('hidden');
        }

        function closeEditModal() {
          document.getElementById('editModal').classList.add('hidden');
        }

        async function saveEmployeeEdit() {
          const oldUserId = document.getElementById('editOldUserId').value;
          const newUserId = document.getElementById('editUserId').value.trim();
          const name = document.getElementById('editName').value.trim();
          const password = document.getElementById('editPassword').value.trim();

          if (!newUserId || !name) return alert('ID 和姓名不能为空！');

          const res = await fetch('/api/admin/update-employee', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldUserId, newUserId, name, password })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            closeEditModal();
            loadEmployees();
          }
        }

        async function toggleResignStatus(targetUserId, status) {
          const actionText = status === 'resigned' ? '离职' : '恢复在职';
          if (!confirm(\`确定要将员工 \${targetUserId} 设置为 \${actionText} 状态吗？\`)) return;

          const res = await fetch('/api/admin/toggle-status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUserId, status })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) loadEmployees();
        }

        async function deleteEmployee(targetUserId) {
          if (!confirm(\`⚠️ 危险操作！确定彻底删除员工 \${targetUserId} 及其所有历史打卡记录吗？\`)) return;

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
    <body class="bg-gray-50 min-h-screen p-4 sm:p-8">
      <div class="max-w-4xl mx-auto space-y-6">
        
        <!-- Header -->
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-white p-6 rounded-xl shadow-sm gap-4">
          <div>
            <h1 class="text-2xl font-bold text-gray-800">员工打卡控制台</h1>
            <p class="text-gray-500 mt-1">当前员工 ID: <span id="dispUserId" class="font-bold text-blue-600">---</span></p>
          </div>
          <div class="flex space-x-2 no-print w-full sm:w-auto">
            <button onclick="window.print()" class="flex-1 sm:flex-initial bg-gray-700 text-white px-4 py-2 rounded-lg text-sm">🖨️ 打印记录</button>
            <button id="logoutBtn" onclick="logout()" class="flex-1 sm:flex-initial bg-red-500 text-white px-4 py-2 rounded-lg text-sm">退出登录</button>
          </div>
        </div>

        <!-- 月份选择与统计 -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div class="bg-white p-6 rounded-xl shadow-sm md:col-span-2 space-y-4">
            <div class="flex justify-between items-center border-b pb-3">
              <h3 class="text-sm font-semibold text-gray-500">考勤数据统计</h3>
              <div class="flex items-center space-x-2">
                <label class="text-xs text-gray-500">选择月份:</label>
                <input type="month" id="monthPicker" onchange="loadAttendanceData()" class="border p-1.5 rounded text-sm bg-gray-50">
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <div class="bg-blue-50 p-4 rounded-lg">
                <div class="text-gray-500 text-xs sm:text-sm">当月工时 (扣休息)</div>
                <div class="text-2xl sm:text-3xl font-extrabold text-blue-600 mt-1"><span id="totalWork">0</span> h</div>
              </div>
              <div class="bg-orange-50 p-4 rounded-lg">
                <div class="text-gray-500 text-xs sm:text-sm">当月 OT (加班)</div>
                <div class="text-2xl sm:text-3xl font-extrabold text-orange-600 mt-1"><span id="totalOt">0</span> h</div>
              </div>
            </div>
          </div>

          <!-- 打卡按钮按区 -->
          <div id="clockArea" class="bg-white p-6 rounded-xl shadow-sm flex flex-col justify-center items-center no-print">
            <button id="clockBtn" onclick="toggleClock()" class="w-full h-24 text-xl font-bold rounded-xl text-white transition bg-green-500 hover:bg-green-600 shadow-md">
              上班打卡 (IN)
            </button>
            <p id="clockStatus" class="text-xs text-gray-400 mt-2 text-center">点击记录当前时刻</p>
          </div>
        </div>

        <!-- 📝 补录与修改区域 -->
        <div id="manualArea" class="bg-white p-6 rounded-xl shadow-sm no-print">
          <h3 id="formTitle" class="text-lg font-bold mb-4">添加 / 修改打卡记录</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label class="text-xs text-gray-400">选择日期</label>
              <input type="text" id="mDate" placeholder="选择日期" class="border p-2 rounded-lg w-full bg-white cursor-pointer mt-1">
            </div>
            <div>
              <label class="text-xs text-gray-400">上班时间 (24小时制)</label>
              <input type="text" id="mIn" placeholder="选择时间" class="border p-2 rounded-lg w-full bg-white cursor-pointer mt-1">
            </div>
            <div>
              <label class="text-xs text-gray-400">下班时间 (24小时制)</label>
              <input type="text" id="mOut" placeholder="选择时间" class="border p-2 rounded-lg w-full bg-white cursor-pointer mt-1">
            </div>
            <div class="flex items-end">
              <button onclick="addManualRecord()" class="bg-indigo-600 text-white w-full py-2.5 rounded-lg font-semibold hover:bg-indigo-700 transition">保存记录</button>
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

          <!-- 查看更多按键 -->
          <div id="expandContainer" class="mt-4 text-center hidden no-print">
            <button id="expandBtn" onclick="toggleShowAll()" class="bg-gray-100 text-blue-600 hover:bg-gray-200 px-6 py-2 rounded-lg font-medium text-sm transition">
              👇 点击查看更多记录
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
        
        let fullHistoryData = [];
        let isExpanded = false;

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
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Kuala_Lumpur'
          });
        }

        async function init() {
          initTimePickers();
          
          // 设置默认月份为本月
          const now = new Date();
          const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          document.getElementById('monthPicker').value = currentMonthStr;

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
          const selectedMonth = document.getElementById('monthPicker').value;
          const res = await fetch(\`/api/attendance/\${targetUserId}?month=\${selectedMonth}\`);
          const data = await res.json();
          
          document.getElementById('totalWork').innerText = data.totalWorkHours;
          document.getElementById('totalOt').innerText = data.totalOtHours;

          if (currentUser.role === 'employee') {
            const btn = document.getElementById('clockBtn');
            const status = document.getElementById('clockStatus');
            if (!data.todayRecord || !data.todayRecord.clockIn) {
              btn.innerText = "上班打卡 (IN)";
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-green-500 hover:bg-green-600 transition shadow-md";
              status.innerText = "状态：未打卡";
              btn.disabled = false;
            } else if (data.todayRecord.clockIn && !data.todayRecord.clockOut) {
              btn.innerText = "下班打卡 (OUT)";
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-red-500 hover:bg-red-600 transition shadow-md";
              status.innerText = \`已签到：\${formatTo24HourTime(data.todayRecord.clockIn)}\`;
              btn.disabled = false;
            } else {
              btn.innerText = "今日打卡完成";
              btn.disabled = true;
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-gray-400 cursor-not-allowed";
              status.innerText = "明日跨天后可再次打卡";
            }
          }

          fullHistoryData = data.history || [];
          isExpanded = false; // 重新加载数据时恢复默认收起状态
          renderHistoryTable();
        }

        function renderHistoryTable() {
          const container = document.getElementById('expandContainer');
          const btn = document.getElementById('expandBtn');
          
          const displayData = isExpanded ? fullHistoryData : fullHistoryData.slice(0, 7);

          const table = document.getElementById('historyTable');
          if (fullHistoryData.length === 0) {
            table.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-gray-400">该月份暂无打卡记录</td></tr>`;
            container.classList.add('hidden');
            return;
          }

          table.innerHTML = displayData.map(row => {
            const inTime24 = formatTo24HourTime(row.clockIn);
            const outTime24 = formatTo24HourTime(row.clockOut);
            
            return \`
              <tr>
                <td class="p-3 font-medium">\${row.date}</td>
                <td class="p-3">\${inTime24 || '-'}</td>
                <td class="p-3">\${outTime24 || '-'}</td>
                <td class="p-3 font-semibold text-blue-600">\${row.workHours} 小时</td>
                <td class="p-3 font-semibold text-orange-600">\${row.otHours} 小时</td>
                <td class="p-3"><span class="px-2 py-1 text-xs rounded \${row.isManual ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}">\${row.isManual ? '补录/修改' : '实时打卡'}</span></td>
                <td class="p-3 no-print space-x-1 whitespace-nowrap">
                  <button onclick="editRow('\${row.date}', '\${inTime24}', '\${outTime24}')" class="text-indigo-600 hover:text-indigo-900 font-semibold text-xs border border-indigo-200 px-2 py-1 rounded hover:bg-indigo-50">✏️ 修改</button>
                  <button onclick="deleteRow('\${row.date}')" class="text-red-600 hover:text-red-900 font-semibold text-xs border border-red-200 px-2 py-1 rounded hover:bg-red-50">🗑️ 删除</button>
                </td>
              </tr>
            \`;
          }).join('');

          if (fullHistoryData.length > 7) {
            container.classList.remove('hidden');
            if (isExpanded) {
              btn.innerText = "👆 折叠部分记录";
            } else {
              btn.innerText = \`👇 点击查看更多（剩余 \${fullHistoryData.length - 7} 条记录）\`;
            }
          } else {
            container.classList.add('hidden');
          }
        }

        function toggleShowAll() {
          isExpanded = !isExpanded;
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
          
          if (!date || !clockIn || !clockOut) return alert('请完整选择日期以及具体的上下班时间！');

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
