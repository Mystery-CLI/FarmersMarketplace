import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

const STATUS_COLORS = {
  pending: '#f59e0b',
  confirmed: '#10b981',
  failed: '#ef4444',
};

const STATUS_LABELS = {
  pending: '⏳ Pending',
  confirmed: '✅ Confirmed',
  failed: '❌ Failed',
};

const POLL_INTERVAL_MS = 5000;

export default function Payments() {
  const [intentId, setIntentId] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [polling, setPolling] = useState(false);
  const intervalRef = useRef(null);

  const stopPolling = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setPolling(false);
  };

  const fetchStatus = async (id) => {
    try {
      const data = await api.get(`/payments/status/${id}`);
      setStatus(data.data);
      if (data.data.status !== 'pending') stopPolling();
    } catch (e) {
      setError(e.message || 'Failed to fetch payment status');
      stopPolling();
    }
  };

  const startPolling = (id) => {
    stopPolling();
    setPolling(true);
    fetchStatus(id);
    intervalRef.current = setInterval(() => fetchStatus(id), POLL_INTERVAL_MS);
  };

  useEffect(() => () => stopPolling(), []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!intentId.trim()) return;
    setError(null);
    setStatus(null);
    startPolling(intentId.trim());
  };

  const statusColor = status ? STATUS_COLORS[status.status] : '#6b7280';

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', padding: 24 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>Payment Status</h2>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <input
          value={intentId}
          onChange={(e) => setIntentId(e.target.value)}
          placeholder="Enter payment intent ID"
          style={{ flex: 1, padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db' }}
        />
        <button
          type="submit"
          style={{ padding: '8px 16px', background: '#2d6a4f', color: '#fff', borderRadius: 6, border: 'none', cursor: 'pointer' }}
        >
          Track
        </button>
      </form>

      {error && (
        <div style={{ background: '#fee2e2', color: '#b91c1c', padding: 12, borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {status && (
        <div style={{ background: '#fff', border: `2px solid ${statusColor}`, borderRadius: 12, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>
              {STATUS_LABELS[status.status] || status.status}
            </span>
            {polling && (
              <span style={{ fontSize: 12, color: '#6b7280' }}>Polling every 5s…</span>
            )}
          </div>
          <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.8 }}>
            <div><strong>Intent ID:</strong> {status.intent_id}</div>
            <div><strong>Amount:</strong> {status.amount} XLM</div>
            <div><strong>Destination:</strong> {status.destination}</div>
            {status.tx_hash && <div><strong>TX Hash:</strong> {status.tx_hash}</div>}
            {status.confirmed_at && <div><strong>Confirmed:</strong> {new Date(status.confirmed_at).toLocaleString()}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
