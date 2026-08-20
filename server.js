const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 云数据库连接配置
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://woyaonpy2005_db_user:Lim050831.@cluster0.ztvp8bb.mongodb.net/ticket_system?appName=Cluster0";

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 连接 MongoDB Atlas 数据库
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ 成功连接至 MongoDB Atlas 云数据库'))
    .catch(err => console.error('❌ MongoDB 连接失败:', err));

// 定义数据结构 Schema
const recordSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    date: { type: String, required: true },
    time: { type: String, required: true },
    currency: { type: String, default: 'MYR' },
    adultCount: { type: Number, default: 0 },
    childCount: { type: Number, default: 0 },
    photographerCount: { type: Number, default: 0 },
    photographerName: { type: String, default: '' },
    photoAdultCount: { type: Number, default: 0 },
    photoChildCount: { type: Number, default: 0 },
    hasGuide: { type: Boolean, default: false },
    totalCount: { type: Number, default: 0 },
    paymentMethod: { type: String, required: true },
    totalPrice: { type: Number, default: 0 },
    totalPriceRM: { type: Number, default: 0 },
    totalPriceRMB: { type: Number, default: 0 },
    convertedRMB: { type: Number, default: 0 },
    displayPrice: { type: String, default: '' },
    details: { type: String }
}, { timestamps: true });

const Record = mongoose.model('Record', recordSchema);

// API 接口设计

// GET: 获取所有售票记录
app.get('/api/records', async (req, res) => {
    try {
        const records = await Record.find().sort({ createdAt: 1 });
        res.json(records);
    } catch (err) {
        console.error("GET 错误:", err);
        res.status(500).json({ error: '获取数据失败' });
    }
});

// POST: 新增售票记录
app.post('/api/records', async (req, res) => {
    try {
        const newRecord = new Record(req.body);
        await newRecord.save();
        res.json({ success: true, record: newRecord });
    } catch (err) {
        console.error("POST 保存失败:", err);
        res.status(500).json({ error: '数据保存失败', details: err.message });
    }
});

// PUT: 修改门票记录
app.put('/api/records/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updatedRecord = await Record.findOneAndUpdate({ id: id }, req.body, { new: true });
        if (!updatedRecord) return res.status(404).json({ error: '未找到该记录' });
        res.json({ success: true, record: updatedRecord });
    } catch (err) {
        console.error("PUT 错误:", err);
        res.status(500).json({ error: '更新失败' });
    }
});

// DELETE: 删除门票记录
app.delete('/api/records/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const deletedRecord = await Record.findOneAndDelete({ id: id });
        if (!deletedRecord) return res.status(404).json({ error: '未找到要删除的记录' });
        res.json({ success: true });
    } catch (err) {
        console.error("DELETE 错误:", err);
        res.status(500).json({ error: '删除失败' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 服务启动，监听端口: ${PORT}`);
});
