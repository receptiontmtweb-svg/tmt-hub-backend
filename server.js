require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// 🔐 Middleware auth simple
function requireAuth(req, res, next) {
  const key = req.headers['x-tmt-key'];
  if (!key || key !== process.env.TMT_MASTER_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 🟢 Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV || 'dev'
  });
});

// 🔐 Test sécurisé
app.post('/api/test', requireAuth, (req, res) => {
  res.json({ ok: true, message: 'Auth OK' });
});

// 🚀 Start
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});