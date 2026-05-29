const mongoose = require('mongoose');

const AlertSchema = new mongoose.Schema({
  userId:    { type: String, default: 'default' },
  coinId:    { type: String, required: true },
  coinName:  { type: String, required: true },
  condition: { type: String, enum: ['above', 'below'], required: true },
  price:     { type: Number, required: true },
  triggered: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const WatchlistSchema = new mongoose.Schema({
  userId: { type: String, default: 'default' },
  coins:  [String],
});

const PortfolioSchema = new mongoose.Schema({
  userId:     { type: String, default: 'default' },
  coinId:     { type: String, required: true },
  coinName:   { type: String, required: true },
  symbol:     { type: String, required: true },
  image:      { type: String },
  quantity:   { type: Number, required: true },
  entryPrice: { type: Number, required: true },
  entryDate:  { type: Date, default: Date.now },
  createdAt:  { type: Date, default: Date.now },
});

module.exports = {
  Alert:     mongoose.model('Alert',     AlertSchema),
  Watchlist: mongoose.model('Watchlist', WatchlistSchema),
  Portfolio: mongoose.model('Portfolio', PortfolioSchema),
};
