import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

// StrictMode is deliberately off: it double-invokes effects in development, and
// JOEY ORTIZ owns a real repeating timer plus a speech engine. Double-mounting
// those in dev produces misleading watchdog/heartbeat noise.
createRoot(container).render(<App />);
