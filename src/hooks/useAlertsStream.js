import { useEffect, useState } from 'react';

export function useAlertsStream() {
  const [alerts, setAlerts] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/arbitrage/alerts-stream');

    es.onopen = () => setConnected(true);

    es.onerror = () => setConnected(false);

    es.onmessage = ev => {
      try {
        const data = JSON.parse(ev.data);

        setAlerts(prev => [data, ...prev].slice(0, 50));
      } catch {}
    };

    return () => es.close();
  }, []);

  return {
    alerts,
    connected,
  };
}