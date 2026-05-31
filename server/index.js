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
const PORT    = process.env.PORT || 5000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Desactivamos CSP para permitir carga de logos externos de criptomonedas
app.use(helmet({ contentSecurityPolicy: false }));

// ─── CORS ─────────────────────────────────────────────────────────────────
// In production on Railway/Render: if frontend is served from the SAME Express
// process (dist/ static), CORS is not needed at all (same-origin).
// If frontend is on Vercel/separate domain, set FRONTEND_URL env var.
// Fallback allows all origins in dev and any Railway-served same-origin prod.
const allowedOrigins = (() => {
  const origins = ['http://localhost:5173', 'http://localhost:3000'];
  if (process.env.FRONTEND_URL) {
    // Support comma-separated list of origins if needed
    process.env.FRONTEND_URL.split(',').forEach(u => origins.push(u.trim()));
  }
  return origins;
})();

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (same-origin, curl, Postman, SSE in prod)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // In production, if FRONTEND_URL is not set, allow the Railway/Render domain
    // that serves this same app (same-origin proxied through express.static)
    if (IS_PROD && !process.env.FRONTEND_URL) return cb(null, true);
    return cb(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
}));

app.use(express.json());
// app.use(rateLimit({ windowMs: 60_000, max: 1000, standardHeaders: true, legacyHeaders: false }));

let dbConnected = false;
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
    .then(() => { dbConnected = true; console.log('◈ MongoDB conectado'); })
    .catch(e => console.warn('⚠ MongoDB no disponible:', e.message));
}

app.use('/api/crypto',     cryptoRoutes);
app.use('/api/arbitrage', arbitrageRoutes);
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString(), db: dbConnected, env: IS_PROD ? 'production' : 'development' }));

const { Alert, Watchlist, Portfolio } = require('./models');

// Helper: check if DB is ready before running a query (mongoose already required above)
const isDbReady = () => mongoose.connection.readyState === 1;

const wrap = fn => async (req, res) => {
  try { res.json({ ok: true, data: await fn(req) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

// DB-gated wrapper: returns empty/mock data immediately when no DB is connected
// instead of hanging 10s then throwing a Mongoose buffering timeout error.
const wrapDb = (fn, fallback) => async (req, res) => {
  if (!isDbReady()) {
    const data = typeof fallback === 'function' ? fallback(req) : fallback;
    return res.json({ ok: true, data, _noDb: true });
  }
  try { res.json({ ok: true, data: await fn(req) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

app.get('/api/alerts',    wrapDb(() => Alert.find({ userId: 'default' }).sort({ createdAt: -1 }), []));
app.post('/api/alerts',   wrapDb(req => Alert.create({ ...req.body, userId: 'default' }), null));
app.delete('/api/alerts/:id', wrapDb(req => Alert.findByIdAndDelete(req.params.id), null));
app.patch('/api/alerts/:id',  wrapDb(req => Alert.findByIdAndUpdate(req.params.id, req.body, { new: true }), null));

app.get('/api/watchlist', wrapDb(async () => {
  const doc = await Watchlist.findOne({ userId: 'default' });
  return { coins: doc?.coins || [] };
}, { coins: [] }));
app.post('/api/watchlist', wrapDb(async req => {
  const doc = await Watchlist.findOneAndUpdate(
    { userId: 'default' }, { coins: req.body.coins }, { upsert: true, new: true }
  );
  return { coins: doc.coins };
}, req => ({ coins: req.body?.coins || [] })));

app.get('/api/portfolio',    wrapDb(() => Portfolio.find({ userId: 'default' }).sort({ createdAt: -1 }), []));
app.post('/api/portfolio',   wrapDb(req => Portfolio.create({ ...req.body, userId: 'default' }), null));
app.delete('/api/portfolio/:id', wrapDb(req => Portfolio.findByIdAndDelete(req.params.id), null));

const { parseCSV, analyzeDataset } = require('./datasetService');

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

const shutdown = (sig) => {
  console.log(`\n◈ ${sig} — shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));