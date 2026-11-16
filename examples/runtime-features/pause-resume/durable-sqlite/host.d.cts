export interface HostExampleReport {
  mode: 'source' | 'built';
  sdkVersion: string;
  cases: ReadonlyArray<{ case: string; [fact: string]: unknown }>;
  ownedChildrenExited: number;
  privateScratchRemoved: boolean;
  limits: readonly string[];
}
export function runExample(options?: { mode?: 'source' | 'built' }): Promise<HostExampleReport>;
