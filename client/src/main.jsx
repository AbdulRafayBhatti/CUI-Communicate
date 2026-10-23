import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Safety net: a render error in one screen must never leave the user on a blank page.
class ErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error('UI error:', error?.message); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <h1>Something went wrong</h1>
          <p>This screen could not be displayed. Your messages are safe. Reload the page to continue, or return to your inbox.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
          <button className="alt" onClick={() => { this.setState({ failed: false }); }}>Try again</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
