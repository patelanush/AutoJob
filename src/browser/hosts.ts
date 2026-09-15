export class HostSafety {
  readonly blocked = new Map<string, string>();
  private forbidden = new Map<string, number>();
  check(host: string) {
    const reason = this.blocked.get(host);
    if (reason) throw new Error(`Host paused for this run: ${reason}`);
  }
  response(host: string, status: number) {
    if (status === 429) this.blocked.set(host, "HTTP 429");
    if (status === 403) {
      const n = (this.forbidden.get(host) ?? 0) + 1;
      this.forbidden.set(host, n);
      if (n >= 2) this.blocked.set(host, "Repeated HTTP 403");
    }
  }
  challenge(host: string) {
    this.blocked.set(host, "Security challenge");
  }
  reset() {
    this.blocked.clear();
    this.forbidden.clear();
  }
}
