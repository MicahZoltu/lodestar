import {phase0} from "@lodestar/types";

export enum LightclientEvent {
  /**
   * New head
   */
  head = "head",
  /**
   * New finalized
   */
  finalized = "finalized",
}

export type LightclientEvents = {
  [LightclientEvent.head]: (newHeader: phase0.BeaconBlockHeader) => void;
  [LightclientEvent.finalized]: (newHeader: phase0.BeaconBlockHeader) => void;
};

export type LightclientEmitter = MittEmitter<LightclientEvents>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MittEmitter<T extends Record<string, (...args: any[]) => void>> = {
  on<K extends keyof T>(type: K, handler: T[K]): void;
  off<K extends keyof T>(type: K, handler: T[K]): void;
  emit<K extends keyof T>(type: K, ...args: Parameters<T[K]>): void;
};
