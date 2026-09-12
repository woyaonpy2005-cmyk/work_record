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

// 💡 放大请求体积限制（防止本地上传大图时报错 413 Payload Too Large）
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// 💡 Session 配置：5 分钟自动过期
app.use(session({
  secret: 'attendance_secret_key_123',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 5 * 60 * 1000 }
}));

// ==================== 1. 数据库模型定义 ====================
const DEFAULT_AVATAR = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%236B7280'><path d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/></svg>";

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' },
  avatarUrl: { type: String, default: DEFAULT_AVATAR },
  bgUrl: { type: String, default: '' }
});
const User = mongoose.model('User', userSchema);

const attendanceSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  date: { type: String, required: true },
  clockIn: { type: Date, default: null },
  clockOut: { type: Date, default: null },
  workHours: { type: Number, default: 0 }, 
  otHours: { type: Number, default: 0 },   
  isManual: { type: Boolean, default: false },
  remark: { type: String, default: '' }     
});
const Attendance = mongoose.model('Attendance', attendanceSchema);

// 连接 MongoDB
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

const getTodayStr = () => {
  const d = new Date();
  return d.toLocaleDateString('en-CA', { timeZone: TIMEZONE_NAME });
};

const calculateHours = (inTime, outTime) => {
  if (!inTime || !outTime) return { workHours: 0, otHours: 0 };
  const diffMs = new Date(outTime) - new Date(inTime);
  const totalHours = Math.max(0, diffMs / (1000 * 60 * 60));
  
  const actualWork = Math.max(0, totalHours - 1); 
  const STANDARD_WORK_HOURS = 7.5; 
  
  const ot = Math.max(0, actualWork - STANDARD_WORK_HOURS);
  const regularWork = Math.min(actualWork, STANDARD_WORK_HOURS);
  
  return {
    workHours: parseFloat(regularWork.toFixed(4)),
    otHours: parseFloat(ot.toFixed(4))
  };
};

// ==================== 2. API 路由 ====================

app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;
  const user = await User.findOne({ userId });
  if (!user) return res.status(400).json({ message: '账号不存在' });

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(400).json({ message: '密码错误' });

  req.session.user = { 
    userId: user.userId, 
    role: user.role, 
    name: user.name,
    avatarUrl: user.avatarUrl || DEFAULT_AVATAR,
    bgUrl: user.bgUrl || ''
  };
  res.json({ role: user.role, userId: user.userId });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录或登录已超时' });
  const user = await User.findOne({ userId: req.session.user.userId });
  if (user) {
    req.session.user.avatarUrl = user.avatarUrl || DEFAULT_AVATAR;
    req.session.user.bgUrl = user.bgUrl || '';
  }
  res.json(req.session.user);
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.post('/api/user/update-theme', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录或登录已超时' });
  const { avatarUrl, bgUrl } = req.body;

  const user = await User.findOne({ userId: req.session.user.userId });
  if (!user) return res.status(404).json({ message: '找不到该用户' });

  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl.trim() || DEFAULT_AVATAR;
  if (bgUrl !== undefined) user.bgUrl = bgUrl.trim();

  await user.save();
  req.session.user.avatarUrl = user.avatarUrl;
  req.session.user.bgUrl = user.bgUrl;

  res.json({ message: '外观设置保存成功！', avatarUrl: user.avatarUrl, bgUrl: user.bgUrl });
});

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

app.get('/api/admin/employees', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ message: '无权限操作' });
  }
  const employees = await User.find({ role: 'employee' }, 'userId name');
  res.json(employees);
});

app.get('/api/attendance/:targetUserId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: '未登录或登录已超时' });
  
  const targetUserId = req.params.targetUserId;
  const monthFilter = req.query.month;
  const today = getTodayStr();

  const userObj = await User.findOne({ userId: targetUserId }, 'userId name avatarUrl bgUrl role');

  let query = { userId: targetUserId };
  if (monthFilter) {
    query.date = { $regex: `^${monthFilter}` };
  }

  let todayRecord = await Attendance.findOne({ userId: targetUserId, date: today });
  const history = await Attendance.find(query).sort({ date: -1 });

  const totals = history.reduce((acc, item) => {
    acc.totalWork += item.workHours || 0;
    acc.totalOt += item.otHours || 0;
    return acc;
  }, { totalWork: 0, totalOt: 0 });

  res.json({
    userInfo: userObj || {},
    todayRecord,
    history,
    totalWorkHours: parseFloat(totals.totalWork.toFixed(4)),
    totalOtHours: parseFloat(totals.totalOt.toFixed(4))
  });
});

app.post('/api/attendance/toggle', async (req, res) => {
  const user = req.session.user;
  if (!user || user.role !== 'employee') return res.status(403).json({ message: '仅员工账户能进行快捷实时打卡' });

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

app.post('/api/attendance/manual', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: '未登录或登录已超时' });

  let { date, clockIn, clockOut, targetUserId, remark } = req.body;
  if (!date || !clockIn || !clockOut) return res.status(400).json({ message: '请选择完整的日期与时间' });

  if (user.role === 'admin' && targetUserId && targetUserId !== user.userId) {
    return res.status(403).json({ message: '管理员仅具备查看权限，无法修改员工考勤数据！' });
  }

  const updateUserId = user.userId;
  const inDateTime = new Date(`${date}T${clockIn}:00${TIMEZONE_OFFSET}`);
  const outDateTime = new Date(`${date}T${clockOut}:00${TIMEZONE_OFFSET}`);

  if (isNaN(inDateTime.getTime()) || isNaN(outDateTime.getTime())) {
    return res.status(400).json({ message: '输入的日期或时间格式不正确' });
  }

  if (outDateTime <= inDateTime) return res.status(400).json({ message: '签退时间必须晚于签到时间' });

  const { workHours, otHours } = calculateHours(inDateTime, outDateTime);
  await Attendance.findOneAndUpdate(
    { userId: updateUserId, date },
    { 
      userId: updateUserId, 
      date, 
      clockIn: inDateTime, 
      clockOut: outDateTime, 
      workHours, 
      otHours, 
      isManual: true,
      remark: remark || ''
    },
    { upsert: true, new: true }
  );

  res.json({ message: '打卡记录已更新/保存成功！' });
});

app.delete('/api/attendance/delete', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: '未登录或登录已超时' });

  const { date, targetUserId } = req.body;
  if (!date) return res.status(400).json({ message: '缺少参数：日期' });

  if (user.role === 'admin' && targetUserId && targetUserId !== user.userId) {
    return res.status(403).json({ message: '管理员仅具备查看权限，无法删除员工考勤数据！' });
  }

  const deleteUserId = user.userId;
  const deleted = await Attendance.findOneAndDelete({ userId: deleteUserId, date });
  if (!deleted) return res.status(404).json({ message: '未找到该日期的打卡记录' });

  res.json({ message: '记录已成功删除！' });
});

// ==================== 3. 前端页面路由 ====================

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
    <body class="bg-gray-100 min-h-screen p-4 md:p-8">
      <div class="max-w-4xl mx-auto space-y-6">
        <div class="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm">
          <h1 class="text-2xl font-bold text-gray-800">管理员控制台</h1>
          <button onclick="logout()" class="bg-red-500 text-white px-4 py-2 rounded-lg hover:bg-red-600 text-sm font-semibold transition">退出登录</button>
        </div>

        <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h2 class="text-xl font-bold mb-4">添加新员工</h2>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input type="text" id="newId" placeholder="员工 ID (例如: emp01)" class="border p-2 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <input type="text" id="newName" placeholder="员工姓名" class="border p-2 rounded-lg outline-none focus:ring-2 focus:ring-green-500">
            <div class="relative">
              <input type="password" id="newPass" placeholder="初始密码" class="border p-2 pr-10 rounded-lg w-full outline-none focus:ring-2 focus:ring-green-500">
              <button type="button" onclick="togglePasswordVisibility('newPass', 'eyeNew')" class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 hover:text-gray-700">
                <span id="eyeNew">👁️</span>
              </button>
            </div>
          </div>
          <button onclick="addEmployee()" class="mt-4 bg-green-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-green-700 transition">添加员工</button>
        </div>

        <div class="bg-white p-6 rounded-xl shadow-sm border border-gray-200">
          <h2 class="text-xl font-bold mb-4">员工列表</h2>
          <div id="employeeList" class="grid grid-cols-1 md:grid-cols-2 gap-4"></div>
        </div>
      </div>

      <script>
        (function setupAutoLogout() {
          let timer;
          const FIVE_MINUTES = 5 * 60 * 1000;

          function resetTimer() {
            clearTimeout(timer);
            timer = setTimeout(async () => {
              alert('您已超过 5 分钟未进行任何操作，系统已自动登出。');
              await logout();
            }, FIVE_MINUTES);
          }

          window.onload = resetTimer;
          document.onmousemove = resetTimer;
          document.onkeypress = resetTimer;
          document.onclick = resetTimer;
          document.onscroll = resetTimer;
        })();

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
          if (!res.ok) return location.href = '/';
          const user = await res.json();
          if (user.role !== 'admin') return location.href = '/employee';

          loadEmployees();
        }

        async function loadEmployees() {
          const res = await fetch('/api/admin/employees');
          if (res.status === 401) {
            alert('登录已超时，请重新登录');
            return location.href = '/';
          }
          const employees = await res.json();
          
          const container = document.getElementById('employeeList');
          if (employees.length === 0) {
            container.innerHTML = '<div class="text-gray-400">暂无员工账号</div>';
            return;
          }

          container.innerHTML = employees.map(emp => \`
            <div class="p-4 border rounded-xl flex justify-between items-center bg-gray-50">
              <div>
                <div class="font-bold text-lg text-blue-600">\${emp.userId}</div>
                <div class="text-gray-600 text-sm">\${emp.name}</div>
              </div>
              <button onclick="viewEmployee('\${emp.userId}')" class="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition">查看考勤 (只读)</button>
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

app.get('/employee', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>考勤控制台</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
      <script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
      <style>
        /* 🎨 优化后的 CSS 自动居中与等比自适应样式 */
        .header-console-bg {
          background-color: #2563eb;
          background-size: cover;          /* 保证图片铺满且不拉伸变形 */
          background-position: center;      /* 自动将图片的重点部分居中对齐 */
          background-repeat: no-repeat;
          transition: background 0.3s ease;
        }

        @media print {
          .no-print { display: none !important; }
          body { background: white !important; padding: 0; }
          .shadow-sm, .shadow-md, .shadow-xl { box-shadow: none !important; }
        }
      </style>
    </head>
    <body class="bg-gray-100 p-4 md:p-8 min-h-screen">
      <div class="max-w-5xl mx-auto space-y-6">

        <!-- 只读模式提示横幅 -->
        <div id="readOnlyBanner" class="hidden bg-amber-500 text-white p-3 rounded-xl shadow-md text-center font-bold text-sm flex items-center justify-center space-x-2">
          <span>🔒 当前为管理员查看模式 (仅供调阅数据，无法修改或添加打卡记录)</span>
        </div>

        <!-- 控制台头部卡片 -->
        <div id="headerCard" class="header-console-bg relative p-6 md:p-8 rounded-2xl shadow-lg border border-blue-400 overflow-hidden text-white transition-all duration-300">
          <div class="absolute inset-0 bg-black/35 z-0 backdrop-blur-[1px]"></div>

          <div class="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
            <div class="flex items-center space-x-4">
              <img id="userAvatar" src="${DEFAULT_AVATAR}" alt="头像" class="w-16 h-16 rounded-full border-2 border-white/80 object-cover bg-white shadow-md flex-shrink-0">
              <div>
                <h1 class="text-2xl md:text-3xl font-extrabold tracking-wide drop-shadow">打卡控制台</h1>
                <p class="text-blue-100 text-sm mt-1">当前查看员工 ID: <span id="dispUserId" class="font-bold underline text-white">---</span></p>
              </div>
            </div>

            <div class="space-x-2 no-print flex w-full md:w-auto justify-end flex-wrap gap-y-2">
              <button id="backAdminBtn" onclick="location.href='/admin'" class="hidden bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg text-sm font-semibold transition shadow-md">
                ⬅️ 返回 Admin 面板
              </button>
              <button onclick="window.print()" class="bg-white/20 hover:bg-white/30 text-white backdrop-blur-md px-4 py-2 rounded-lg text-sm font-medium border border-white/30 transition shadow-sm flex items-center gap-1">🖨️ 打印记录</button>
              <button id="logoutBtn" onclick="logout()" class="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition shadow-sm">退出登录</button>
            </div>
          </div>

          <!-- 修改头像与背景按钮 -->
          <div id="themeChangeBtnBox" class="relative z-10 flex justify-end mt-6 no-print">
            <button onclick="openThemeModal()" class="bg-white/20 hover:bg-white/30 text-white border border-white/40 backdrop-blur-md text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm flex items-center space-x-1.5 transition transform hover:scale-105">
              <span>🖼️</span>
              <span>修改头像/背景 (智能适应)</span>
            </button>
          </div>
        </div>

        <!-- 考勤数据概览区 -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div id="statsBox" class="bg-white p-4 md:p-6 rounded-xl shadow-sm border border-gray-200 md:col-span-2 transition-all">
            <h3 class="text-sm font-semibold text-gray-500 mb-2">月度考勤统计</h3>
            <div class="grid grid-cols-2 gap-4">
              <div class="bg-blue-50 p-4 rounded-lg border border-blue-100">
                <div class="text-gray-500 text-xs sm:text-sm">月总工作时长 (已扣休息)</div>
                <div class="text-xl sm:text-2xl font-extrabold text-blue-600 mt-1" id="totalWork">0 小时</div>
              </div>
              <div class="bg-orange-50 p-4 rounded-lg border border-orange-100">
                <div class="text-gray-500 text-xs sm:text-sm">月总 OT (加班时长)</div>
                <div class="text-xl sm:text-2xl font-extrabold text-orange-600 mt-1" id="totalOt">0 小时</div>
              </div>
            </div>
          </div>

          <!-- 快捷打卡区域 -->
          <div id="clockArea" class="bg-white p-4 md:p-6 rounded-xl shadow-sm border border-gray-200 flex flex-col justify-center items-center no-print">
            <button id="clockBtn" onclick="toggleClock()" class="w-full h-24 text-xl font-bold rounded-xl text-white transition bg-green-500 hover:bg-green-600 shadow-md">
              上班打卡 (IN)
            </button>
            <p id="clockStatus" class="text-xs text-gray-400 mt-2 text-center">点击记录当前时刻</p>
          </div>
        </div>

        <!-- 补录与修改区域 -->
        <div id="manualArea" class="bg-white p-4 md:p-6 rounded-xl shadow-sm border border-gray-200 no-print">
          <h3 id="formTitle" class="text-lg font-bold mb-4 text-gray-800">添加/修改打卡记录</h3>
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
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
            <div>
              <label class="text-xs text-gray-400">备注</label>
              <input type="text" id="mRemark" placeholder="如: 请假、外勤" class="border p-2 rounded-lg w-full bg-white outline-none focus:ring-2 focus:ring-indigo-500">
            </div>
            <div class="flex items-end">
              <button onclick="addManualRecord()" class="bg-indigo-600 text-white w-full py-2 rounded-lg font-semibold hover:bg-indigo-700 transition shadow">保存记录</button>
            </div>
          </div>
        </div>

        <!-- 历史记录表格 -->
        <div class="bg-white p-4 md:p-6 rounded-xl shadow-sm border border-gray-200">
          <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
            <h3 class="text-lg font-bold text-gray-800">打卡历史记录</h3>
            <div class="flex items-center space-x-2 no-print">
              <label class="text-sm text-gray-500 font-medium">查看月份：</label>
              <input type="month" id="monthPicker" onchange="onMonthChange()" class="border border-gray-300 rounded-lg p-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50">
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[700px]">
              <thead>
                <tr class="border-b bg-gray-50 text-gray-600 text-sm">
                  <th class="p-3">日期 (星期)</th>
                  <th class="p-3">上班打卡</th>
                  <th class="p-3">下班打卡</th>
                  <th class="p-3">实际工时</th>
                  <th class="p-3">OT 时长</th>
                  <th class="p-3">备注</th>
                  <th class="p-3">类型</th>
                  <th id="thActionHeader" class="p-3 no-print">操作</th>
                </tr>
              </thead>
              <tbody id="historyTable" class="divide-y text-sm"></tbody>
            </table>
          </div>

          <div id="showMoreContainer" class="mt-4 text-center hidden no-print">
            <button id="showMoreBtn" onclick="toggleShowAllHistory()" class="bg-gray-100 text-gray-700 hover:bg-gray-200 px-6 py-2 rounded-lg font-semibold text-sm transition">
              👇 展开更多本月历史记录
            </button>
          </div>
        </div>
      </div>

      <!-- 图片上传与预览 Modal -->
      <div id="themeModal" class="fixed inset-0 bg-black/60 hidden flex items-center justify-center p-4 z-50 no-print">
        <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md space-y-5 text-gray-800">
          <div class="flex justify-between items-center border-b pb-3">
            <h3 class="text-lg font-bold">个性化修改 (自动适应全屏)</h3>
            <button onclick="closeThemeModal()" class="text-gray-400 hover:text-gray-600 font-bold">✕</button>
          </div>
          
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">更换头像</label>
            <div class="flex items-center space-x-3">
              <img id="previewAvatar" src="${DEFAULT_AVATAR}" class="w-12 h-12 rounded-full border object-cover bg-gray-50">
              <label class="cursor-pointer bg-gray-100 hover:bg-gray-200 border text-gray-700 text-xs font-semibold px-3 py-2 rounded-lg transition">
                <span>📁 从手机/相册选择</span>
                <input type="file" id="avatarFileInput" accept="image/*" onchange="handleFileSelect(event, 'avatar')" class="hidden">
              </label>
              <button onclick="resetAvatar()" class="text-xs text-red-500 hover:underline">还原默认</button>
            </div>
          </div>

          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">更换背景照片 (已启用居中裁剪与缩放)</label>
            <div class="space-y-2">
              <div id="previewBgBox" class="w-full h-24 rounded-lg border bg-blue-600 bg-cover bg-center flex items-center justify-center text-xs text-white/90 shadow-inner relative overflow-hidden">
                <span class="z-10 bg-black/40 px-3 py-1 rounded-full backdrop-blur-sm">预览自适应效果</span>
              </div>
              <div class="flex items-center justify-between">
                <label class="cursor-pointer bg-gray-100 hover:bg-gray-200 border text-gray-700 text-xs font-semibold px-3 py-2 rounded-lg transition">
                  <span>📁 选择照片</span>
                  <input type="file" id="bgFileInput" accept="image/*" onchange="handleFileSelect(event, 'bg')" class="hidden">
                </label>
                <button onclick="resetBg()" class="text-xs text-red-500 hover:underline">还原蓝色背景</button>
              </div>
            </div>
          </div>

          <div class="flex justify-end space-x-2 pt-2 border-t">
            <button onclick="closeThemeModal()" class="px-4 py-2 border rounded-lg text-gray-600 hover:bg-gray-100 text-sm">取消</button>
            <button onclick="saveThemeSettings()" class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold text-sm transition">保存配置</button>
          </div>
        </div>
      </div>

      <script>
        const urlParams = new URLSearchParams(window.location.search);
        const viewUserId = urlParams.get('viewUserId');
        let currentUser = null;
        let targetUserId = '';
        let currentTargetUserObj = null;
        let pickerIn, pickerOut, pickerDate;
        let isReadOnlyMode = false;
        
        let fullHistoryData = [];
        let showAllHistory = false;

        let pendingAvatarBase64 = null;
        let pendingBgBase64 = null;

        const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

        function formatDateWithDay(dateStr) {
          if (!dateStr) return '';
          const d = new Date(dateStr + 'T00:00:00');
          if (isNaN(d.getTime())) return dateStr;
          const dayName = weekDays[d.getDay()];
          return \`\${dateStr} (\${dayName})\`;
        }

        (function setupAutoLogout() {
          let timer;
          const FIVE_MINUTES = 5 * 60 * 1000;

          function resetTimer() {
            clearTimeout(timer);
            timer = setTimeout(async () => {
              alert('您已超过 5 分钟未进行任何操作，系统已自动登出。');
              await logout();
            }, FIVE_MINUTES);
          }

          window.onload = resetTimer;
          document.onmousemove = resetTimer;
          document.onkeypress = resetTimer;
          document.onclick = resetTimer;
          document.onscroll = resetTimer;
        })();

        function formatDuration(decimalHours) {
          if (!decimalHours || decimalHours <= 0) return '0 小时';
          const totalMinutes = Math.round(decimalHours * 60);
          const hours = Math.floor(totalMinutes / 60);
          const minutes = totalMinutes % 60;

          if (hours === 0) return \`\${minutes} 分钟\`;
          if (minutes === 0) return \`\${hours} 小时\`;
          return \`\${hours} 小时 \${minutes} 分钟\`;
        }

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

          const now = new Date();
          const currentMonthStr = \`\${now.getFullYear()}-\${String(now.getMonth() + 1).padStart(2, '0')}\`;
          document.getElementById('monthPicker').value = currentMonthStr;
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

          if (currentUser.role === 'admin') {
            document.getElementById('backAdminBtn').classList.remove('hidden');
            if (viewUserId) {
              targetUserId = viewUserId;
              isReadOnlyMode = true; 
            } else {
              targetUserId = currentUser.userId;
            }
          } else {
            targetUserId = currentUser.userId;
          }

          if (isReadOnlyMode) {
            document.getElementById('readOnlyBanner').classList.remove('hidden');
            document.getElementById('clockArea').classList.add('hidden');
            document.getElementById('manualArea').classList.add('hidden');
            document.getElementById('themeChangeBtnBox').classList.add('hidden');
            document.getElementById('thActionHeader').classList.add('hidden');
            
            document.getElementById('statsBox').classList.remove('md:col-span-2');
            document.getElementById('statsBox').classList.add('md:col-span-3');
          }

          document.getElementById('dispUserId').innerText = targetUserId;
          loadAttendanceData();
        }

        function applyUserTheme(avatarUrl, bgUrl) {
          const avatarImg = document.getElementById('userAvatar');
          if (avatarImg) {
            avatarImg.src = avatarUrl || "${DEFAULT_AVATAR}";
          }

          const headerCard = document.getElementById('headerCard');
          if (bgUrl && bgUrl.trim() !== '') {
            headerCard.style.backgroundImage = \`url('\${bgUrl}')\`;
          } else {
            headerCard.style.backgroundImage = 'none';
            headerCard.style.backgroundColor = '#2563eb';
          }
        }

        async function loadAttendanceData() {
          const selectedMonth = document.getElementById('monthPicker').value;
          const res = await fetch(\`/api/attendance/\${targetUserId}?month=\${selectedMonth}\`);
          if (res.status === 401) {
            alert('登录已超时，请重新登录');
            return location.href = '/';
          }
          const data = await res.json();

          currentTargetUserObj = data.userInfo;
          if (currentTargetUserObj) {
            applyUserTheme(currentTargetUserObj.avatarUrl, currentTargetUserObj.bgUrl);
          }
          
          document.getElementById('totalWork').innerText = formatDuration(data.totalWorkHours);
          document.getElementById('totalOt').innerText = formatDuration(data.totalOtHours);

          if (!isReadOnlyMode && currentUser.role === 'employee' && targetUserId === currentUser.userId) {
            const btn = document.getElementById('clockBtn');
            const status = document.getElementById('clockStatus');
            if (!data.todayRecord || !data.todayRecord.clockIn) {
              btn.innerText = "上班打卡 (IN)";
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-green-500 hover:bg-green-600 transition shadow-md";
              status.innerText = "状态：未打卡";
            } else if (data.todayRecord.clockIn && !data.todayRecord.clockOut) {
              btn.innerText = "下班打卡 (OUT)";
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-red-500 hover:bg-red-600 transition shadow-md";
              status.innerText = \`已签到：\${formatTo24HourTime(data.todayRecord.clockIn)}\`;
            } else {
              btn.innerText = "今日打卡完成";
              btn.disabled = true;
              btn.className = "w-full h-24 text-xl font-bold rounded-xl text-white bg-gray-400 cursor-not-allowed shadow-none";
              status.innerText = "明日跨天后可再次打卡";
            }
          }

          fullHistoryData = data.history || [];
          renderHistoryTable();
        }

        function compressAndReadImage(file, maxWidth, maxHeight, callback) {
          const reader = new FileReader();
          reader.onload = function(e) {
            const img = new Image();
            img.onload = function() {
              const canvas = document.createElement('canvas');
              let width = img.width;
              let height = img.height;

              if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
              }
              if (height > maxHeight) {
                width = Math.round((width * maxHeight) / height);
                height = maxHeight;
              }

              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0, width, height);

              const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);
              callback(compressedBase64);
            };
            img.src = e.target.result;
          };
          reader.readAsDataURL(file);
        }

        function handleFileSelect(event, type) {
          const file = event.target.files[0];
          if (!file) return;

          if (type === 'avatar') {
            compressAndReadImage(file, 300, 300, (base64) => {
              pendingAvatarBase64 = base64;
              document.getElementById('previewAvatar').src = base64;
            });
          } else if (type === 'bg') {
            compressAndReadImage(file, 1200, 800, (base64) => {
              pendingBgBase64 = base64;
              const previewBgBox = document.getElementById('previewBgBox');
              previewBgBox.style.backgroundImage = \`url('\${base64}')\`;
            });
          }
        }

        function resetAvatar() {
          pendingAvatarBase64 = "${DEFAULT_AVATAR}";
          document.getElementById('previewAvatar').src = "${DEFAULT_AVATAR}";
        }

        function resetBg() {
          pendingBgBase64 = "";
          const previewBgBox = document.getElementById('previewBgBox');
          previewBgBox.style.backgroundImage = 'none';
        }

        function openThemeModal() {
          if (isReadOnlyMode) return;
          pendingAvatarBase64 = currentTargetUserObj ? currentTargetUserObj.avatarUrl : null;
          pendingBgBase64 = currentTargetUserObj ? currentTargetUserObj.bgUrl : null;

          document.getElementById('previewAvatar').src = pendingAvatarBase64 || "${DEFAULT_AVATAR}";
          
          const previewBgBox = document.getElementById('previewBgBox');
          if (pendingBgBase64 && pendingBgBase64.trim() !== '') {
            previewBgBox.style.backgroundImage = \`url('\${pendingBgBase64}')\`;
          } else {
            previewBgBox.style.backgroundImage = 'none';
          }

          document.getElementById('themeModal').classList.remove('hidden');
        }

        function closeThemeModal() {
          document.getElementById('themeModal').classList.add('hidden');
        }

        async function saveThemeSettings() {
          if (isReadOnlyMode) return;
          const payload = {};
          if (pendingAvatarBase64 !== null) payload.avatarUrl = pendingAvatarBase64;
          if (pendingBgBase64 !== null) payload.bgUrl = pendingBgBase64;

          const res = await fetch('/api/user/update-theme', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            closeThemeModal();
            loadAttendanceData();
          }
        }

        function isWithinLast7Days(dateStr) {
          const today = new Date();
          today.setHours(0,0,0,0);
          const targetDate = new Date(dateStr);
          const diffDays = (today - targetDate) / (1000 * 60 * 60 * 24);
          return diffDays >= 0 && diffDays <= 7;
        }

        function renderHistoryTable() {
          const table = document.getElementById('historyTable');
          const showMoreContainer = document.getElementById('showMoreContainer');
          const showMoreBtn = document.getElementById('showMoreBtn');

          if (fullHistoryData.length === 0) {
            const colspanVal = isReadOnlyMode ? 7 : 8;
            table.innerHTML = \`<tr><td colspan="\${colspanVal}" class="p-4 text-center text-gray-400">该月份暂无打卡记录</td></tr>\`;
            showMoreContainer.classList.add('hidden');
            return;
          }

          let displayData = fullHistoryData;

          if (!showAllHistory) {
            const recent7DaysData = fullHistoryData.filter(item => isWithinLast7Days(item.date));
            displayData = recent7DaysData.length > 0 ? recent7DaysData : fullHistoryData.slice(0, 7);
          }

          if (fullHistoryData.length > displayData.length || showAllHistory) {
            showMoreContainer.classList.remove('hidden');
            showMoreBtn.innerText = showAllHistory ? "☝️ 折叠仅看近一礼拜" : \`👇 查看本月更多记录 (共 \${fullHistoryData.length} 条)\`;
          } else {
            showMoreContainer.classList.add('hidden');
          }

          table.innerHTML = displayData.map(row => {
            const inTime24 = formatTo24HourTime(row.clockIn);
            const outTime24 = formatTo24HourTime(row.clockOut);
            const dateWithDay = formatDateWithDay(row.date);
            
            return \`
              <tr>
                <td class="p-3 font-medium">\${dateWithDay}</td>
                <td class="p-3">\${inTime24 || '-'}</td>
                <td class="p-3">\${outTime24 || '-'}</td>
                <td class="p-3 font-semibold text-blue-600">\${formatDuration(row.workHours)}</td>
                <td class="p-3 font-semibold text-orange-600">\${formatDuration(row.otHours)}</td>
                <td class="p-3 text-gray-600">\${row.remark || '-'}</td>
                <td class="p-3"><span class="px-2 py-1 text-xs rounded \${row.isManual ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}">\${row.isManual ? '手动补录/修改' : '实时打卡'}</span></td>
                \${!isReadOnlyMode ? \`
                  <td class="p-3 no-print space-x-2">
                    <button onclick="editRow('\${row.date}', '\${inTime24}', '\${outTime24}', '\${encodeURIComponent(row.remark || '')}')" class="text-indigo-600 hover:text-indigo-900 font-semibold text-xs border border-indigo-200 px-2 py-1 rounded hover:bg-indigo-50 transition">✏️ 修改</button>
                    <button onclick="deleteRow('\${row.date}')" class="text-red-600 hover:text-red-900 font-semibold text-xs border border-red-200 px-2 py-1 rounded hover:bg-red-50 transition">🗑️ 删除</button>
                  </td>
                \` : ''}
              </tr>
            \`;
          }).join('');
        }

        function toggleShowAllHistory() {
          showAllHistory = !showAllHistory;
          renderHistoryTable();
        }

        function onMonthChange() {
          showAllHistory = false;
          loadAttendanceData();
        }

        function editRow(date, clockIn, clockOut, encodedRemark) {
          if (isReadOnlyMode) return;
          pickerDate.setDate(date);
          pickerIn.setDate(clockIn);
          pickerOut.setDate(clockOut);
          document.getElementById('mRemark').value = decodeURIComponent(encodedRemark);
          
          const targetArea = document.getElementById('manualArea');
          targetArea.scrollIntoView({ behavior: 'smooth' });
        }

        async function deleteRow(date) {
          if (isReadOnlyMode) return;
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
          if (isReadOnlyMode) return;
          const res = await fetch('/api/attendance/toggle', { method: 'POST' });
          const data = await res.json();
          alert(data.message);
          loadAttendanceData();
        }

        async function addManualRecord() {
          if (isReadOnlyMode) return;
          const date = document.getElementById('mDate').value;
          const clockIn = document.getElementById('mIn').value;
          const clockOut = document.getElementById('mOut').value;
          const remark = document.getElementById('mRemark').value;
          
          if (!date || !clockIn || !clockOut) {
            return alert('请完整选择日期以及具体的上下班时间！');
          }

          const res = await fetch('/api/attendance/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ date, clockIn, clockOut, targetUserId, remark })
          });
          const data = await res.json();
          alert(data.message);
          if (res.ok) {
            pickerDate.clear();
            pickerIn.clear();
            pickerOut.clear();
            document.getElementById('mRemark').value = '';
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
