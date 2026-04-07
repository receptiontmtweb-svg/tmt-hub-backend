require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: 'TMT HUB v20' });
});
app.use('/api/credentials', require('./backend/routes/credentials'));
app.use('/api/amazon', require('./backend/routes/amazon'));
app.use('/api/octopia', require('./backend/routes/octopia'));
app.use('/api/transport', require('./backend/routes/transport'));
app.use('/api/orders', require('./backend/routes/orders'));
app.use('/api/products', require('./backend/routes/products'));
app.use('/api/queue', require('./backend/routes/queue'));
app.use('/api/packlink', require('./backend/routes/packlink'));
app.use('/api/ebay', require('./backend/routes/ebay'));
app.use('/api/relay', require('./backend/routes/relay'));
if (require.main === module) { app.listen(3001); }
module.exports = app;
