'use strict';

module.exports = {
  name: 'Kraken',
  id: 'kraken',
  enabled: true,
  wsUrl: 'wss://ws.kraken.com/v2',
  pairs: ['BTC', 'ETH'],
  fees: { maker: 0.0016, taker: 0.0026 },
  region: 'eu',
  symbolMap: { BTC: 'BTC/USD', ETH: 'ETH/USD' },
  rateLimitPerMinute: 900,
};
