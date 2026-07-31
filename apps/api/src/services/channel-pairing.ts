export type ChannelPairingDecision = 'approve' | 'deny';

export function decidePendingPairing(params: {
  status: string;
  expiresAt: Date;
  decision: ChannelPairingDecision;
  now?: Date;
}): 'approved' | 'denied' {
  if (params.status !== 'pending' || params.expiresAt <= (params.now ?? new Date())) {
    throw new Error('pairing request is not pending');
  }
  return params.decision === 'approve' ? 'approved' : 'denied';
}

export function addConnectionScopedPeer(allowFrom: string[], peerId: string): string[] {
  if (!/^-?\d{3,25}$/.test(peerId)) throw new Error('invalid channel peer id');
  const next = [...new Set([...allowFrom, peerId])];
  if (next.length > 100) throw new Error('channel allowlist is full');
  return next;
}
