export interface OperatorRequestToken {
  readonly generation: number;
  readonly days: number;
}

/**
 * A tiny last-request-wins gate for the operator cockpit. Network responses
 * can arrive out of order when the window or Refresh changes quickly; only
 * the newest request may publish its combined usage/health/runtime snapshot.
 */
export class OperatorRequestGate {
  private generation = 0;

  begin(days: number): OperatorRequestToken {
    this.generation += 1;
    return { generation: this.generation, days };
  }

  isCurrent(token: OperatorRequestToken): boolean {
    return token.generation === this.generation;
  }

  retire(): void {
    this.generation += 1;
  }
}
