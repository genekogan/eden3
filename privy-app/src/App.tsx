import { usePrivy, useWallets } from '@privy-io/react-auth';
import { useState } from 'react';

export default function App() {
  const { ready, authenticated, user, login, logout, linkEmail, linkWallet, linkGoogle } =
    usePrivy();
  const { wallets } = useWallets();
  const [signature, setSignature] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);

  if (!ready) {
    return (
      <div className="container">
        <p>Loading Privy…</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="container">
        <header>
          <h1>Privy Demo</h1>
          <p className="subtitle">A minimal React app showing Privy auth + embedded wallets.</p>
        </header>
        <div className="card center">
          <h2>Sign in</h2>
          <p>Email, wallet, Google, or Twitter — all configured in <code>main.tsx</code>.</p>
          <button className="primary" onClick={login}>
            Log in
          </button>
        </div>
      </div>
    );
  }

  const wallet = wallets[0];

  const handleSign = async () => {
    setSignError(null);
    setSignature(null);
    if (!wallet) {
      setSignError('No wallet available.');
      return;
    }
    try {
      const provider = await wallet.getEthereumProvider();
      const sig = await provider.request({
        method: 'personal_sign',
        params: ['Hello from Privy!', wallet.address],
      });
      setSignature(sig as string);
    } catch (err) {
      setSignError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="container">
      <header className="row between">
        <div>
          <h1>Privy Demo</h1>
          <p className="subtitle">Signed in as {user?.email?.address ?? user?.id}</p>
        </div>
        <button onClick={logout}>Log out</button>
      </header>

      <section className="card">
        <h2>User</h2>
        <dl>
          <dt>Privy ID</dt>
          <dd><code>{user?.id}</code></dd>
          <dt>Created</dt>
          <dd>{user?.createdAt ? new Date(user.createdAt).toLocaleString() : '—'}</dd>
          <dt>Email</dt>
          <dd>{user?.email?.address ?? <em>not linked</em>}</dd>
          <dt>Google</dt>
          <dd>{user?.google?.email ?? <em>not linked</em>}</dd>
          <dt>Twitter</dt>
          <dd>{user?.twitter?.username ?? <em>not linked</em>}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Wallets</h2>
        {wallets.length === 0 ? (
          <p><em>No wallets yet.</em></p>
        ) : (
          <ul className="wallets">
            {wallets.map((w) => (
              <li key={w.address}>
                <code>{w.address}</code>
                <span className="badge">{w.walletClientType}</span>
                <span className="badge muted">chain {w.chainId}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Sign a message</h2>
        <p>Calls <code>personal_sign</code> on the active wallet's EIP-1193 provider.</p>
        <button className="primary" onClick={handleSign} disabled={!wallet}>
          Sign "Hello from Privy!"
        </button>
        {signature && (
          <pre className="result">{signature}</pre>
        )}
        {signError && (
          <p className="error">{signError}</p>
        )}
      </section>

      <section className="card">
        <h2>Link more accounts</h2>
        <div className="row gap">
          <button onClick={linkEmail}>Link email</button>
          <button onClick={linkWallet}>Link wallet</button>
          <button onClick={linkGoogle}>Link Google</button>
        </div>
      </section>
    </div>
  );
}
