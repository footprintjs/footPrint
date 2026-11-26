interface ParentKeys {
  readonly contextProto: readonly string[];
  readonly facadeProto: readonly string[];
  readonly mainExports: readonly string[];
}

/** Apply only the intentional additions to the unchanged historical layout fixture. */
export function expectedReadAuthorityKeys(parent: ParentKeys) {
  return {
    ...parent,
    contextProto: [
      ...parent.contextProto,
      'declaredInvocationOpen',
      'endDeclaredAttemptInvocation',
      'useDeclaredWrites',
    ].sort(),
    facadeProto: [...parent.facadeProto, 'declaredFailureOwner'].sort(),
    mainExports: [
      ...parent.mainExports,
      'readKeysOf',
      'describeChart',
      'listMounts',
      'decideFromFacts',
      'decisionRecord',
      'fixedRecord',
    ].sort(),
  };
}
