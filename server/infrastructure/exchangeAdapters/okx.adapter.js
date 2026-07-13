'use strict';

module.exports = {
  name: 'OKX',
  id: 'okx',
  enabled: true,
  wsUrl: 'wss://ws.okx.com:8443/ws/v5/public',
  pairs: ['BTC', 'ETH'],
  fees: { maker: 0.0008, taker: 0.001 },
  region: 'asia',
  symbolMap: { BTC: 'BTC-USDT', ETH: 'ETH-USDT' },
  rateLimitPerMinute: 600,
};
