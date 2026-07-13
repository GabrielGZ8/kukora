'use strict';

module.exports = {
  name: 'Bybit',
  id: 'bybit',
  enabled: true,
  wsUrl: 'wss://stream.bybit.com/v5/public/spot',
  pairs: ['BTC', 'ETH'],
  fees: { maker: 0.001, taker: 0.001 },
  region: 'asia',
  symbolMap: { BTC: 'BTCUSDT', ETH: 'ETHUSDT' },
  rateLimitPerMinute: 600,
};
