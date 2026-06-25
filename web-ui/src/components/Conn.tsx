import { useUI } from '../lib/store';

export function Conn() {
  const { connected } = useUI();
  return (
    <div className={`conn ${connected ? 'up' : ''}`}>
      <span className="led" />
      {connected ? 'online' : 'reconnecting'}
    </div>
  );
}
