const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const mongoose   = require('mongoose');
const cryptoRoutes     = require('./crypto.routes');
const arbitrageRoutes  = require('./arbitrage.routes');

const app    = express();
app.set('x-powered-by', false);
const PORT   = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';

// FIX: agregar helmet para headers de seguridad y CORS con origen específico
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

let dbConnected = false;
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => { dbConnected = true; console.log('◈ MongoDB conectado'); })
    .catch(e => console.warn('⚠ MongoDB no disponible:', e.message));
}

app.use('/api/crypto',     cryptoRoutes);
app.use('/api/arbitrage', arbitrageRoutes);
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString(), db: dbConnected }));

const { Alert, Watchlist, Portfolio } = require('./models');
const wrap = fn => async (req, res) => {
  try { res.json({ ok: true, data: await fn(req) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

app.get('/api/alerts',    wrap(() => Alert.find({ userId: 'default' }).sort({ createdAt: -1 })));
app.post('/api/alerts',   wrap(req => Alert.create({ ...req.body, userId: 'default' })));
app.delete('/api/alerts/:id', wrap(req => Alert.findByIdAndDelete(req.params.id)));
app.patch('/api/alerts/:id',  wrap(req => Alert.findByIdAndUpdate(req.params.id, req.body, { new: true })));

app.get('/api/watchlist', wrap(async () => {
  const doc = await Watchlist.findOne({ userId: 'default' });
  return { coins: doc?.coins || [] };
}));
app.post('/api/watchlist', wrap(async req => {
  const doc = await Watchlist.findOneAndUpdate(
    { userId: 'default' }, { coins: req.body.coins }, { upsert: true, new: true }
  );
  return { coins: doc.coins };
}));

app.get('/api/portfolio',    wrap(() => Portfolio.find({ userId: 'default' }).sort({ createdAt: -1 })));
app.post('/api/portfolio',   wrap(req => Portfolio.create({ ...req.body, userId: 'default' })));
app.delete('/api/portfolio/:id', wrap(req => Portfolio.findByIdAndDelete(req.params.id)));


// ─── Dataset upload & analysis ────────────────────────────────────────────
const { parseCSV, analyzeDataset } = require('./datasetService');

// POST /api/dataset/analyze — body: { csv: "...", json: [...] }
app.post('/api/dataset/analyze', (req, res) => {
  try {
    let rows = [];
    if (req.body.csv) {
      rows = parseCSV(req.body.csv);
    } else if (req.body.json && Array.isArray(req.body.json)) {
      rows = req.body.json;
    } else {
      return res.status(400).json({ ok: false, error: 'Envía { csv: "..." } o { json: [...] }' });
    }
    if (!rows.length) return res.status(400).json({ ok: false, error: 'Dataset vacío o sin parsear.' });
    const result = analyzeDataset(rows);
    if (result.error) return res.status(422).json({ ok: false, error: result.error });
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/dataset/example — devuelve CSV de ejemplo para testing
app.get('/api/dataset/example', (_, res) => {
  const rows = [];
  let price = 40000;
  const start = new Date('2024-01-01');
  for (let i = 0; i < 90; i++) {
    const date = new Date(start); date.setDate(start.getDate() + i);
    price = price * (1 + (Math.random() - 0.48) * 0.04);
    rows.push({ date: date.toISOString().split('T')[0], price: +price.toFixed(2), volume: Math.round(Math.random() * 1e9) });
  }
  const csv = 'date,price,volume\n' + rows.map(r => `${r.date},${r.price},${r.volume}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="kukora_example.csv"');
  res.send(csv);
});

if (IS_PROD) {
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist));
  app.get('*', (_, res) => res.sendFile(path.join(dist, 'index.html')));
}

const server = app.listen(PORT, () => {
  console.log(`\n◈ kukora → http://localhost:${PORT}`);
  if (!IS_PROD) console.log('  Vite UI   → http://localhost:5173');
  console.log('  API       → http://localhost:' + PORT + '/api/crypto\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${PORT} already in use.`);
    console.error(`  Run: npx kill-port ${PORT}   (or close the other terminal running npm start)\n`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

// Graceful shutdown
const shutdown = (sig) => {
  console.log(`\n◈ ${sig} — shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
