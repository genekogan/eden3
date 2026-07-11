import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import App from './App';
import './styles.css';

const appId = import.meta.env.VITE_PRIVY_APP_ID;

if (!appId) {
  throw new Error(
    'Missing VITE_PRIVY_APP_ID. Copy .env.example to .env.local and set your Privy App ID.',
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['email', 'wallet', 'google', 'twitter'],
        appearance: {
          theme: 'light',
          accentColor: '#5B6CFF',
          logo: undefined,
        },
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
        },
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>,
);
