const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: "TMT HUB LOCAL",
    status: "running"
  });
});

// FAKE SHIPPING (temporaire)
app.post('/api/orders/:id/tracking', (req, res) => {
  console.log("Tracking reçu :", req.params.id, req.body);
  res.json({ ok: true });
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log("Backend lancé sur http://127.0.0.1:" + PORT);
});