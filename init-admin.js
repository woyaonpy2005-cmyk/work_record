const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'employee'], default: 'employee' }
});
const User = mongoose.model('User', userSchema);

async function init() {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/attendance_db');
    console.log('✅ 已连接到 MongoDB');

    const hashedPassword = await bcrypt.hash('123456789', 10);
    
    await User.updateOne(
      { userId: 'admin123' },
      {
        userId: 'admin123',
        password: hashedPassword,
        name: '系统管理员',
        role: 'admin'
      },
      { upsert: true }
    );

    console.log('🎉 管理员账号创建/更新成功！账号: admin123 密码: 123456789');
    process.exit(0);
  } catch (err) {
    console.error('❌ 初始化失败:', err);
    process.exit(1);
  }
}

init();
