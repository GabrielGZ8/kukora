'use strict';

module.exports = {
  name: 'Coinbase',
  id: 'coinbase',
  enabled: true,
  wsUrl: 'wss://advanced-trade-ws.coinbase.com',
  pairs: ['BTC', 'ETH'],
  fees: { maker: 0.004, taker: 0.006 },
  region: 'us',
  symbolMap: { BTC: 'BTC-USD', ETH: 'ETH-USD' },
  rateLimitPerMinute: 300,
};
