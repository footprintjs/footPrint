/** Import-free metadata for proved auxiliary-read observations. */
export interface AuxiliaryReceiverFact {
  readonly kind: 'original-getValueDirect-return';
  readonly nativeReadId: number;
  readonly primaryReadId: number;
  /** SAME observer raw underlying array ID; never StageContext.this or an invented Proxy identity. */
  readonly object: number;
}
export interface AuxiliaryProfile {
  readonly profile: 'root-array-json-operand-v1';
  readonly coordinate: readonly (string | number)[];
  readonly primary: {
    readonly baselineNativeId: number;
    readonly buildNativeId: number;
    readonly baselineObject: number;
  };
  readonly auxiliaryReadCount: number;
  readonly receiverFacts: readonly AuxiliaryReceiverFact[];
}
export interface AuxiliaryEvidence {
  readonly auxiliaryReadCount: number;
  readonly profiles: readonly AuxiliaryProfile[];
}
